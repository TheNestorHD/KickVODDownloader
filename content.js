const memoryChunks = []; // Deprecated: Only used as temporary buffer if needed, but we use IDB now.
// However, existing code might reference it. Let's remove its usage from transmuxer completely.

// Global variables for cleanup
let currentFileHandle = null;
let currentWritable = null;
let currentDownloadVideoId = null; // Track which video we are downloading
let currentDownloadPath = null;
let isDownloading = false;
let cancelRequested = false;
let originalPageTitle = '';
const originalMediaStates = new Map();

// --- Wake Lock / Inactivity Prevention ---
// Keeps the tab active during critical operations (Download / Auto-DL monitoring)
let wakeLockAudioContext = null;
let wakeLockOscillator = null;
let wakeLockCount = 0;
const WAKE_LOCK_DEFAULT_FREQ_HZ = 22000;

function getWakeLockFrequencyHz() {
    const raw = Number(localStorage.getItem('kvd_wake_lock_freq_hz'));
    if (!Number.isFinite(raw)) return WAKE_LOCK_DEFAULT_FREQ_HZ;
    return Math.max(1, Math.min(22000, Math.round(raw)));
}

function preventTabInactivity() {
    wakeLockCount++;
    // console.log(`[WakeLock] Acquired. Count: ${wakeLockCount}`);
    
    if (wakeLockAudioContext) return; // Already active

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        wakeLockAudioContext = new AudioContext();
        wakeLockOscillator = wakeLockAudioContext.createOscillator();
        const gainNode = wakeLockAudioContext.createGain();

        wakeLockOscillator.type = 'sine';
        wakeLockOscillator.frequency.value = getWakeLockFrequencyHz();

        // Practically silent output while keeping the audio thread active.
        // Default frequency is ultrasonic (22kHz) to avoid audible tones.
        gainNode.gain.value = 0.00001;

        wakeLockOscillator.connect(gainNode);
        gainNode.connect(wakeLockAudioContext.destination);
        wakeLockOscillator.start();
        
        // console.log('[WakeLock] Audio Context Started (Inactivity Prevention)');
    } catch (e) {
        console.error('[WakeLock] Failed to start:', e);
    }
}

function allowTabInactivity() {
    if (wakeLockCount > 0) wakeLockCount--;
    // console.log(`[WakeLock] Released. Count: ${wakeLockCount}`);

    if (wakeLockCount === 0 && wakeLockAudioContext) {
        try {
            if (wakeLockOscillator) {
                wakeLockOscillator.stop();
                wakeLockOscillator.disconnect();
            }
            wakeLockAudioContext.close();
        } catch (e) {
            console.error('[WakeLock] Cleanup error:', e);
        }
        wakeLockAudioContext = null;
        wakeLockOscillator = null;
        // console.log('[WakeLock] Audio Context Stopped');
    }
}
// -----------------------------------------

function mutePageAudio() {
    const media = document.querySelectorAll('video, audio');
    media.forEach(el => {
        if (!originalMediaStates.has(el)) {
            originalMediaStates.set(el, { muted: el.muted, volume: el.volume, paused: el.paused });
        }
        try {
            el.muted = true;
            el.volume = 0;
            if (typeof el.pause === 'function') el.pause();
        } catch (_) {}
    });
}

function restorePageAudio() {
    originalMediaStates.forEach((state, el) => {
        try {
            el.muted = state.muted;
            el.volume = state.volume;
            if (!state.paused && typeof el.play === 'function') {
                el.play().catch(() => {});
            }
        } catch (_) {}
    });
    originalMediaStates.clear();
}

// IndexedDB Helper for robust cleanup and temporary storage
const DB_NAME = 'KickDownloaderDB';
const HANDLE_STORE = 'handles';
const CHUNK_STORE = 'chunks';

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(storeName, mode, operation) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;

        try {
            result = operation(store);
        } catch (e) {
            reject(e);
            return;
        }

        const resultPromise = Promise.resolve(result);
        tx.oncomplete = () => {
            resultPromise.then(resolve).catch(reject);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2); // Version 2
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(HANDLE_STORE)) {
                db.createObjectStore(HANDLE_STORE);
            }
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
            }
        };
    });
}

async function saveHandleToDB(handle) {
    try {
        await withStore(HANDLE_STORE, 'readwrite', (store) => {
            store.put(handle, 'interrupted_download');
        });
    } catch (e) { console.error('DB Save Handle Error', e); }
}

async function clearHandleFromDB() {
    try {
        await withStore(HANDLE_STORE, 'readwrite', (store) => {
            store.delete('interrupted_download');
        });
    } catch (e) { console.error('DB Clear Handle Error', e); }
}

async function getHandleFromDB() {
    try {
        return await withStore(HANDLE_STORE, 'readonly', (store) => {
            return requestToPromise(store.get('interrupted_download'));
        });
    } catch (e) {
        console.error('DB Get Handle Error', e);
        return null;
    }
}

async function saveChunkToDB(chunk) {
    try {
        await withStore(CHUNK_STORE, 'readwrite', (store) => {
            store.add(chunk);
        });
    } catch (e) { 
        console.error('DB Save Chunk Error', e);
        throw e; // Critical error
    }
}

async function clearChunksFromDB() {
    try {
        await withStore(CHUNK_STORE, 'readwrite', (store) => {
            store.clear();
        });
    } catch (e) { console.error('DB Clear Chunks Error', e); }
}

async function getAllChunksFromDB() {
    try {
        return await withStore(CHUNK_STORE, 'readonly', (store) => {
            return requestToPromise(store.getAll());
        });
    } catch (e) {
        console.error('DB Get All Chunks Error', e);
        return [];
    }
}

async function checkAndCleanup() {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const request = tx.objectStore(HANDLE_STORE).get('interrupted_download');
        
        request.onsuccess = async () => {
            const handle = request.result;
            if (handle) {
                console.log('Found interrupted download handle');
                // Check permission without prompting
                try {
                    const perm = await handle.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        if (handle.remove) {
                            await handle.remove();
                            console.log('Successfully removed interrupted file');
                        }
                    } else {
                        console.log('Permission not granted to remove file, skipping cleanup to avoid prompt');
                    }
                } catch(e) { console.log('Error checking permission', e); }
                // Clear from DB regardless
                clearHandleFromDB();
            }
        };
        
        // Also clear chunks on startup/cleanup
        clearChunksFromDB();
        
    } catch (e) { console.error('Cleanup Check Error', e); }
}

function showFirstKickVisitAlert() {
    if (location.hostname.startsWith('dashboard.')) return;
    chrome.storage.local.get(['kvd_badge_alert_shown'], (result) => {
        if (result.kvd_badge_alert_shown) return;
        const message = [
            'New features are available via the extension badge (icon). Pin the extension to the toolbar for quick access.',
            'Hay funciones disponibles desde el badge (ícono) de la extensión. Ancla el ícono a la barra de extensiones para acceso rápido.'
        ].join('\n\n');
        alert(message);
        chrome.storage.local.set({ kvd_badge_alert_shown: true });
    });
}

// Run cleanup check on load
checkAndCleanup();
showFirstKickVisitAlert();

const isValidRuntimeMessage = (sender, request) => {
    return sender && sender.id === chrome.runtime.id && request && typeof request.type === 'string';
};

// Cleanup on page reload/close
const handleUnload = () => {
    // Only delete file if we are in the middle of a download
    if (isDownloading && currentFileHandle) {
        // Prioritize removing the file directly.
        // We do NOT call writable.abort() here because it might lock the file 
        // or delay the removal process in the short window we have.
        // The browser will clean up the open handle/stream automatically on process exit,
        // but we need to ensure the file entry is removed from disk.
        if (currentFileHandle.remove) {
             currentFileHandle.remove().catch(e => console.error('Remove on unload failed', e));
        }
    }
};

window.addEventListener('beforeunload', handleUnload);
window.addEventListener('pagehide', handleUnload);

// Listen for messages from background script (Navigation detection) and Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isValidRuntimeMessage(sender, request)) return;
    // --- POPUP: Admin Check ---
    if (request.type === 'CHECK_ADMIN') {
        sendResponse({ isAdmin: isModerator() });
        return true;
    }
    
    // --- POPUP: Get Channel Slug ---
    if (request.type === 'GET_CHANNEL_SLUG') {
        sendResponse({ slug: getChannelSlug() });
        return true;
    }
    
    // --- POPUP: Send Chat ---
    if (request.type === 'SEND_CHAT') {
        if (typeof request.message === 'string' && request.message.trim()) {
            const safeMessage = request.message.slice(0, 500);
            sendChatMessage(safeMessage);
        }
        return true;
    }
});

// Function to extract video ID from URL
function getVideoId() {
    // 1. Try to find UUID explicitly (most robust)
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const uuidMatch = window.location.pathname.match(uuidRegex);
    if (uuidMatch) return uuidMatch[0];

    // 2. Fallback for simple alphanumeric IDs in /video/ or /videos/
    const videoMatch = window.location.pathname.match(/\/(?:video|videos)\/([a-zA-Z0-9-]+)/);
    return videoMatch ? videoMatch[1] : null;
}

// Function to fetch video data
async function fetchVideoData(videoId) {
    try {
        const response = await fetch(`https://kick.com/api/v1/video/${videoId}`, {
            credentials: 'include'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        console.log('API Video Data:', data); // Log full API response for debugging
        return data;
    } catch (error) {
        console.error('Error fetching video data:', error);
        return { error: error.message };
    }
}

// Helper to update button state
function updateButton(btn, text, disabled = false, progress = null) {
    btn.disabled = disabled;
    const isThumb = btn.classList.contains('kvd-thumb-btn');

    if (progress !== null) {
        btn.textContent = isThumb ? `${progress}%` : `${text} (${progress}%)`;
        btn.style.background = `linear-gradient(to right, #53fc18 ${progress}%, #333 ${progress}%)`;
        btn.style.color = progress > 50 ? '#000' : '#fff';
    } else {
        btn.textContent = text;
        btn.style.background = '';
        btn.style.color = '';
    }
}

function createDownloadSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke", "currentColor");
    
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12");
    
    svg.appendChild(path);
    return svg;
}

function setButtonToDownload(btn) {
    btn.textContent = '';
    
    if (btn.classList.contains('kvd-thumb-btn')) {
        btn.innerHTML = '<span>⬇</span>';
        btn.title = 'Download';
    } else {
        btn.appendChild(createDownloadSvg());
        btn.appendChild(document.createTextNode('\n        Download\n    '));
    }
    
    btn.style.background = '';
    btn.disabled = false;
}

// Helper to format bytes
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Helper to create and update overlay
function updateOverlay(progress, text = 'Downloading...', etaText = '', currentBytes = 0, currentSpeed = 0) {
    let overlay = document.getElementById('kick-vod-overlay');
    
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'kick-vod-overlay';
        // Create overlay elements safely
        
        const h2 = document.createElement('h2');
        h2.textContent = 'Downloading VOD / Descargando VOD';
        overlay.appendChild(h2);

        const p = document.createElement('p');
        p.className = 'kvd-overlay-warning';
        p.textContent = 'Please do not close this tab or navigate away.\nPor favor, no cierres esta pestaña ni navegues a otra página.';
        overlay.appendChild(p);

        const container = document.createElement('div');
        container.className = 'progress-bar-container';
        
        const fill = document.createElement('div');
        fill.className = 'progress-bar-fill';
        container.appendChild(fill);
        overlay.appendChild(container);

        const progressText = document.createElement('div');
        progressText.className = 'progress-text';
        progressText.textContent = '0%';
        overlay.appendChild(progressText);

        const sizeText = document.createElement('div');
        sizeText.className = 'size-text';
        sizeText.style.fontSize = '0.9em';
        sizeText.style.color = '#fff';
        sizeText.style.marginTop = '5px';
        sizeText.style.fontWeight = 'bold';
        sizeText.textContent = 'Size / Tamaño: 0 MB';
        overlay.appendChild(sizeText);

        const etaTextDiv = document.createElement('div');
        etaTextDiv.className = 'eta-text';
        etaTextDiv.style.marginTop = '10px';
        etaTextDiv.style.fontSize = '0.9em';
        etaTextDiv.style.color = '#ccc';
        overlay.appendChild(etaTextDiv);

        const disclaimer = document.createElement('div');
        disclaimer.className = 'disclaimer-text';
        disclaimer.style.marginTop = '15px';
        disclaimer.style.fontSize = '0.85em';
        disclaimer.style.color = '#ffcc00';
        disclaimer.style.maxWidth = '90%';
        disclaimer.style.lineHeight = '1.4';
        disclaimer.style.border = '1px solid #555';
        disclaimer.style.background = 'rgba(0,0,0,0.3)';
        disclaimer.style.padding = '10px';
        disclaimer.style.borderRadius = '5px';
        
        const strong1 = document.createElement('strong');
        strong1.textContent = 'Note: ';
        disclaimer.appendChild(strong1);
        disclaimer.appendChild(document.createTextNode('The downloaded video may be up to 2 minutes shorter than the live stream due to platform limitations.\n'));
        
        const strong2 = document.createElement('strong');
        strong2.textContent = 'Nota: ';
        disclaimer.appendChild(strong2);
        disclaimer.appendChild(document.createTextNode('El video descargado puede durar hasta 2 minutos menos que el directo debido a limitaciones de la plataforma.\n'));

        const em = document.createElement('em');
        em.textContent = "(Streamers: Please leave an 'outro' screen at the end / Dejar pantalla de 'outro' al final)";
        disclaimer.appendChild(em);
        
        disclaimer.style.whiteSpace = 'pre-wrap';
        overlay.appendChild(disclaimer);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'kvd-btn-cancel-overlay';
        cancelBtn.textContent = 'Cancel Download / Cancelar';
        overlay.appendChild(cancelBtn);
        document.body.appendChild(overlay);
        
        // Prevent scroll
        document.body.style.overflow = 'hidden';
        mutePageAudio();

        // Bind cancel button
        overlay.querySelector('.kvd-btn-cancel-overlay').addEventListener('click', async () => {
             if (confirm('Are you sure you want to cancel? / ¿Seguro que quieres cancelar?')) {
                 cancelRequested = true;
                 overlay.querySelector('h2').textContent = 'Cancelling...';
             }
        });
    }

    if (progress !== null) {
        overlay.querySelector('.progress-bar-fill').style.width = `${progress}%`;
        overlay.querySelector('.progress-text').textContent = `${progress}%`;
        
        if (currentBytes > 0) {
            const sizeEl = overlay.querySelector('.size-text');
            if (sizeEl) {
                let sizeStr = `Size / Tamaño: ${formatBytes(currentBytes)}`;
                if (currentSpeed > 0) {
                    const speedMb = (currentSpeed / 1024 / 1024).toFixed(1);
                    sizeStr += `  •  ${speedMb} MB/s`;
                }
                sizeEl.textContent = sizeStr;
            }
        }
        
        const etaEl = overlay.querySelector('.eta-text');
        if (etaEl) etaEl.textContent = etaText;

        // Warn about duration mismatch if present
        const warningEl = overlay.querySelector('.duration-warning');
        if (!warningEl && window.kickVodDurationMismatch) {
             const warningDiv = document.createElement('div');
             warningDiv.className = 'duration-warning';
             warningDiv.style.color = '#ffaa00';
             warningDiv.style.fontSize = '0.85em';
             warningDiv.style.marginTop = '8px';
             warningDiv.style.fontWeight = 'bold';
             warningDiv.textContent = `⚠️ Duration Warning: Kick says ${window.kickVodDurationMismatch.api}, but only ${window.kickVodDurationMismatch.actual} is available in playlist.\nAdvertencia: Kick indica ${window.kickVodDurationMismatch.api}, pero solo hay ${window.kickVodDurationMismatch.actual} disponibles.`;
             warningDiv.style.whiteSpace = 'pre-wrap';
             
             // Insert after size text
             const sizeEl = overlay.querySelector('.size-text');
             if (sizeEl) sizeEl.parentNode.insertBefore(warningDiv, sizeEl.nextSibling);
        }

        // Send progress to background script for badge update
        try {
            chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', progress: progress }).catch(() => {});
        } catch (e) { /* ignore */ }
        
        // Update page title
        if (originalPageTitle && progress !== 100) {
             document.title = `[${progress}%] ${originalPageTitle}`;
        }
    }
    
    // Update main text if provided (e.g. "Finalizing...")
    if (text && text !== 'Downloading...') {
         const h2 = overlay.querySelector('h2');
         if (h2) h2.textContent = text;
    }
}

function removeOverlay() {
    const overlay = document.getElementById('kick-vod-overlay');
    if (overlay) {
        // Clear badge
        try {
            chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', progress: null }).catch(() => {});
        } catch (e) { /* ignore */ }

        // Restore title
        if (originalPageTitle) {
            document.title = originalPageTitle;
            originalPageTitle = '';
        }

        restorePageAudio();
        overlay.remove();
        document.body.style.overflow = ''; // Restore scroll
    }
}

// Helper to patch MP4 headers (mvhd, tkhd, mdhd)
function patchMp4Header(initSegment, durationMs, avgBitrate = 0) {
    try {
        const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
        
        // Helper to read box
        const readBox = (pos) => {
            if (pos + 8 > view.byteLength) return null;
            const size = view.getUint32(pos);
            const type = String.fromCharCode(
                view.getUint8(pos + 4), view.getUint8(pos + 5),
                view.getUint8(pos + 6), view.getUint8(pos + 7)
            );
            return { size, type, offset: pos };
        };

        // Recursive box searcher
        const findBox = (start, end, type) => {
            let pos = start;
            while (pos < end) {
                const box = readBox(pos);
                if (!box) break;
                if (box.type === type) return box;
                pos += box.size;
            }
            return null;
        };

        // 0. Check for btrt injection (Windows Bitrate Fix)
        const moovCheck = findBox(0, view.byteLength, 'moov');
        if (moovCheck) {
            let trakPos = moovCheck.offset + 8;
            while (trakPos < moovCheck.offset + moovCheck.size) {
                const trak = readBox(trakPos);
                if (trak && trak.type === 'trak') {
                    const mdia = findBox(trak.offset + 8, trak.offset + trak.size, 'mdia');
                    if (mdia) {
                        const minf = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'minf');
                        if (minf) {
                            const stbl = findBox(minf.offset + 8, minf.offset + minf.size, 'stbl');
                            if (stbl) {
                                const stsd = findBox(stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
                                if (stsd) {
                                    const avc1 = findBox(stsd.offset + 12, stsd.offset + stsd.size, 'avc1');
                                    if (avc1) {
                                        const childrenStart = avc1.offset + 8 + 78;
                                        const btrt = findBox(childrenStart, avc1.offset + avc1.size, 'btrt');
                                        
                                        if (!btrt) {
                                            console.log('[Patch] btrt atom missing, injecting for Windows compatibility...');
                                            const newSize = initSegment.byteLength + 20;
                                            const newInit = new Uint8Array(newSize);
                                            const newView = new DataView(newInit.buffer);
                                            
                                            // Insert at end of avc1
                                            const insertPos = avc1.offset + avc1.size;
                                            
                                            // Copy before
                                            newInit.set(initSegment.subarray(0, insertPos), 0);
                                            
                                            // btrt (20 bytes)
                                            newView.setUint32(insertPos, 20);
                                            newView.setUint8(insertPos + 4, 0x62); // b
                                            newView.setUint8(insertPos + 5, 0x74); // t
                                            newView.setUint8(insertPos + 6, 0x72); // r
                                            newView.setUint8(insertPos + 7, 0x74); // t
                                            // Data will be filled in recursive call
                                            
                                            // Copy after
                                            newInit.set(initSegment.subarray(insertPos), insertPos + 20);
                                            
                                            // Update sizes of ancestors
                                            const ancestors = [moovCheck, trak, mdia, minf, stbl, stsd, avc1];
                                            ancestors.forEach(box => {
                                                const oldSize = view.getUint32(box.offset);
                                                newView.setUint32(box.offset, oldSize + 20);
                                            });
                                            
                                            return patchMp4Header(newInit, durationMs, avgBitrate);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                trakPos += trak.size;
            }
        }

        // 1. Find moov
        const moov = findBox(0, view.byteLength, 'moov');
        if (!moov) return initSegment;

        // 2. Patch mvhd (Movie Header)
        const mvhd = findBox(moov.offset + 8, moov.offset + moov.size, 'mvhd');
        let globalTimescale = 90000; // Default fallback
        
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            
            globalTimescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
            
            if (version === 0) {
                view.setUint32(durationOffset, durationUnits);
            } else {
                 view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                 view.setUint32(durationOffset + 4, durationUnits % 4294967296);
            }
        }

        // 3. Patch trak -> tkhd (Track Header) and mdia -> mdhd (Media Header)
        let trakPos = moov.offset + 8;
        while (trakPos < moov.offset + moov.size) {
            const box = readBox(trakPos);
            if (!box) break;
            if (box.type === 'trak') {
                // Patch tkhd
                const tkhd = findBox(box.offset + 8, box.offset + box.size, 'tkhd');
                if (tkhd) {
                    const version = view.getUint8(tkhd.offset + 8);
                    const durationOffset = tkhd.offset + 8 + (version === 0 ? 20 : 28);
                    
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);

                    if (version === 0) {
                        view.setUint32(durationOffset, durationUnits);
                    } else {
                        view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                        view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                    }
                }

                // Patch mdia -> mdhd
                const mdia = findBox(box.offset + 8, box.offset + box.size, 'mdia');
                if (mdia) {
                    const mdhd = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
                    if (mdhd) {
                         const version = view.getUint8(mdhd.offset + 8);
                         const timescaleOffset = mdhd.offset + 8 + (version === 0 ? 12 : 20);
                         const durationOffset = timescaleOffset + 4;
                         
                         const localTimescale = view.getUint32(timescaleOffset);
                         const durationUnits = Math.round((durationMs / 1000) * localTimescale);
                         
                         if (version === 0) {
                             view.setUint32(durationOffset, durationUnits);
                         } else {
                             view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                             view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                         }
                    }

                    // Attempt to patch bitrate in minf -> stbl -> stsd -> avc1 -> btrt
                    const minf = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'minf');
                    if (minf) {
                        const stbl = findBox(minf.offset + 8, minf.offset + minf.size, 'stbl');
                        if (stbl) {
                            const stsd = findBox(stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
                            if (stsd) {
                                const avc1 = findBox(stsd.offset + 12, stsd.offset + stsd.size, 'avc1');
                                if (avc1) {
                                    const childrenStart = avc1.offset + 8 + 78;
                                    const btrt = findBox(childrenStart, avc1.offset + avc1.size, 'btrt');
                                    if (btrt) {
                                        const maxBitrateOffset = btrt.offset + 12;
                                        const avgBitrateOffset = btrt.offset + 16;
                                        
                                        const finalAvgBitrate = avgBitrate > 0 ? avgBitrate : 8000000;
                                        const finalMaxBitrate = Math.max(Math.round(finalAvgBitrate * 1.5), 12000000);
                                        
                                        view.setUint32(maxBitrateOffset, finalMaxBitrate);
                                        view.setUint32(avgBitrateOffset, finalAvgBitrate);
                                        console.log(`Patching btrt: Max=${finalMaxBitrate}, Avg=${finalAvgBitrate} (Source: ${avgBitrate > 0 ? 'Calculated' : 'Default'})`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            trakPos += box.size;
        }
        
        return initSegment;
    } catch (e) {
        console.error('Error patching MP4 headers:', e);
        return initSegment;
    }
}

// Helper to send desktop notifications (only if tab is hidden)
function sendNotification(title, message) {
    if (document.hidden) {
        chrome.runtime.sendMessage({
            type: 'SHOW_NOTIFICATION',
            title: title,
            message: message
        }).catch(e => console.log('Notification failed:', e));
    }
}

function isAllowedStreamUrl(url, baseHost) {
    try {
        const parsed = new URL(url, window.location.href);
        if (!['https:', 'http:'].includes(parsed.protocol)) return false;
        if (!baseHost) return true;
        return parsed.hostname === baseHost || parsed.hostname.endsWith(`.${baseHost}`);
    } catch (e) {
        console.warn('Invalid stream URL detected:', url, e);
        return false;
    }
}

function resetDownloadState() {
    isDownloading = false;
    allowTabInactivity();
    cancelRequested = false;
    currentDownloadVideoId = null;
    currentDownloadPath = null;
    currentFileHandle = null;
    currentWritable = null;
}

function isUserCancellationError(error) {
    const name = typeof error?.name === 'string' ? error.name : '';
    const message = typeof error?.message === 'string' ? error.message : String(error || '');
    return name === 'AbortError'
        || message.includes('user aborted')
        || message.includes('cancelled by user');
}

async function cleanupDownloadArtifacts({ clearChunks = false, removeFile = false } = {}) {
    if (clearChunks) {
        await clearChunksFromDB();
    }
    if (removeFile && currentFileHandle && currentFileHandle.remove) {
        await currentFileHandle.remove().catch(e => console.error('Remove failed', e));
    }
}

async function convertM4aToMp3(blob) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported('audio/mpeg')) {
        throw new Error('MP3 encoding not supported in this browser');
    }
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const destination = audioContext.createMediaStreamDestination();
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(destination);

    const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/mpeg' });
    const chunks = [];

    const recordPromise = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        recorder.onerror = (event) => reject(event.error || event);
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/mpeg' }));
    });

    recorder.start();
    source.start(0);

    const durationMs = Math.max(0, audioBuffer.duration * 1000);
    await new Promise(resolve => setTimeout(resolve, durationMs + 250));
    recorder.stop();
    source.stop();
    audioContext.close().catch(() => {});

    return recordPromise;
}

async function downloadSegments(streamUrl, btn, videoDurationMs, startSeconds = 0, endSeconds = -1, preOpenedHandle = null, forceMemory = false, explicitVideoId = null) {
    let isAudioOnly = false;
    let audioOnlyFormat = null;
    let usedIdbFallback = false;
    let shouldClearChunks = false;
    let shouldRemoveFile = false;
    let objectUrl = null;
    let tempLink = null;
    let shouldResetState = false;
    let deferObjectUrlCleanup = false;

    try {
        // Check for Audio Only mode (passed via URL hash)
        if (streamUrl.includes('#audio_only')) {
            isAudioOnly = true;
            const match = streamUrl.match(/#audio_only(?:=(mp3|m4a))?/i);
            audioOnlyFormat = match && match[1] ? match[1].toLowerCase() : 'm4a';
            streamUrl = streamUrl.replace(/#audio_only(?:=[^#]*)?/i, '');
            console.log(`Audio Only Mode Detected (${audioOnlyFormat?.toUpperCase() || 'M4A/AAC'})`);
        }

        if (audioOnlyFormat === 'mp3') {
            forceMemory = true;
        }

        isDownloading = true;
        preventTabInactivity(); // Prevent tab sleep during download
        cancelRequested = false;
        currentDownloadVideoId = explicitVideoId || getVideoId(); // Use explicit ID if provided

        // Save original title only if not already saved (prevents recursion issues)
        if (!originalPageTitle) {
            originalPageTitle = document.title;
        }


        // --- FILE PICKER MOVED HERE TO SATISFY USER GESTURE REQUIREMENT ---
        // We must ask for the file handle immediately, before any network requests (fetch)
        let handle = preOpenedHandle;

        if (forceMemory) {
            handle = null;
        }
        
        // Only ask if we don't have a handle AND we support the API AND it's not a recursive call with handle AND not forced memory mode
        if (!forceMemory && !handle && typeof window.showSaveFilePicker === 'function') {
             try {
                 // Suggest filename
                 const ext = isAudioOnly ? 'm4a' : 'mp4';
                 const desc = isAudioOnly ? 'M4A Audio' : 'MP4 Video';
                 const mime = isAudioOnly ? { 'audio/mp4': ['.m4a'] } : { 'video/mp4': ['.mp4'] };
                 const suggestedName = `kick-vod-${explicitVideoId || getVideoId() || 'video'}.${ext}`;
                 
                 handle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: desc,
                        accept: mime,
                    }],
                });
                
                // Store globally immediately
                currentFileHandle = handle; 
                saveHandleToDB(handle); 
                
                // Show overlay AFTER picker to avoid visual glitch if user cancels picker
                updateOverlay(0);
                
             } catch (pickerError) {
                 // User cancelled or error
                 console.log('User cancelled save picker or error:', pickerError);
                 isDownloading = false;
                 allowTabInactivity();
                 setButtonToDownload(btn);
                 return; // Stop execution
             }
        } else if (!handle) {
            // No API support or fallback needed later
            updateOverlay(0);
        } else {
            // We have a handle (recursive call), just show overlay
             updateOverlay(0);
        }
        // ------------------------------------------------------------------

        // Try to get duration from DOM if API failed (common in fresh VODs)
        if (!videoDurationMs || videoDurationMs === 0) {
            const videoEl = document.querySelector('video');
            if (videoEl && !isNaN(videoEl.duration) && videoEl.duration > 0) {
                videoDurationMs = Math.round(videoEl.duration * 1000);
                console.log(`Using DOM Video Duration as fallback: ${videoDurationMs}ms`);
            }
        }

        const baseStreamHost = (() => {
            try {
                return new URL(streamUrl).hostname;
            } catch {
                return null;
            }
        })();

        // 1. Fetch playlist with Cache Buster to avoid stale CDNs
        const fetchUrl = streamUrl + (streamUrl.includes('?') ? '&' : '?') + `time=${Date.now()}`;
        console.log(`Fetching playlist: ${fetchUrl}`);
        
        const response = await fetch(fetchUrl, { cache: 'no-store' });
        const playlistText = await response.text();
        
        // Simple parser for m3u8 to find segments
        const lines = playlistText.split('\n');
        let segments = [];
        let baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

        console.log(`M3U8 URL: ${streamUrl}`);
        
        // Check for endlist tag
        const hasEndList = playlistText.includes('#EXT-X-ENDLIST');
        console.log(`Playlist has ENDLIST tag: ${hasEndList}`);

        // Parse Master Playlist to find best variant
        if (playlistText.includes('EXT-X-STREAM-INF')) {
            console.log('Master Playlist detected. Analyzing variants for best duration/quality...');
            const variants = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('EXT-X-STREAM-INF')) {
                    // Try to parse bandwidth
                    const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;
                    
                    // Try to parse resolution
                    const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                    const resolution = resMatch ? resMatch[1] : 'unknown';

                    // The URL is usually on the next line
                    let j = i + 1;
                    while (j < lines.length && lines[j].startsWith('#')) {
                        j++;
                    }
                    if (j < lines.length && lines[j].trim().length > 0) {
                        const url = lines[j].trim();
                        variants.push({ bandwidth, resolution, url: url.startsWith('http') ? url : baseUrl + url });
                    }
                }
            }
            
            if (variants.length > 0) {
                // Check durations of all variants to find the most complete one
                updateButton(btn, 'Analyzing qualities...', true);
                console.log(`Found ${variants.length} variants. Checking durations...`);
                
                const variantAnalysis = await Promise.all(variants.map(async (v) => {
                    try {
                        const vUrl = v.url + (v.url.includes('?') ? '&' : '?') + `time=${Date.now()}`;
                        const res = await fetch(vUrl, { cache: 'no-store' });
                        const text = await res.text();
                        const vLines = text.split('\n');
                        let dur = 0;
                        let segCount = 0;
                        for (const line of vLines) {
                            if (line.startsWith('#EXTINF:')) {
                                const d = parseFloat(line.substring(8).split(',')[0]);
                                if (!isNaN(d)) dur += d;
                                segCount++;
                            }
                        }
                        return { ...v, duration: dur, segments: segCount };
                    } catch (e) {
                        console.error(`Error checking variant ${v.resolution}:`, e);
                        return { ...v, duration: 0, segments: 0 };
                    }
                }));

                // Sort by Duration DESC, then Bandwidth DESC
                variantAnalysis.sort((a, b) => {
                    // Give a 5-second tolerance for duration differences
                    if (Math.abs(b.duration - a.duration) > 5) {
                        return b.duration - a.duration; // Prefer longer video
                    }
                    return b.bandwidth - a.bandwidth; // Then prefer higher quality
                });

                const bestVariant = variantAnalysis[0];
                console.log('Variant Analysis Results:', variantAnalysis);
                console.log(`Selected Best Variant: ${bestVariant.resolution} (${bestVariant.bandwidth}bps) - Duration: ${bestVariant.duration}s`);

                let targetUrl = bestVariant.url;
                if (isAudioOnly) targetUrl += '#audio_only';

                return downloadSegments(targetUrl, btn, videoDurationMs, startSeconds, endSeconds, handle, forceMemory);
            }
            
            // Fallback to simple search if parsing failed
            const m3u8Match = lines.find(l => l.endsWith('.m3u8') && !l.startsWith('#'));
            if (m3u8Match) {
                let newUrl = m3u8Match.startsWith('http') ? m3u8Match : baseUrl + m3u8Match;
                console.log(`Fallback: Found .m3u8 link, redirecting to: ${newUrl}`);
                if (isAudioOnly) newUrl += '#audio_only';
                return downloadSegments(newUrl, btn, videoDurationMs, startSeconds, endSeconds, handle, forceMemory);
            }
        }

        // Parse segments and calculate duration if needed
        let calculatedDuration = 0;
        let segmentDurations = [];
        let totalPlaylistDuration = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const durationStr = line.substring(8).split(',')[0];
                const d = parseFloat(durationStr);
                
                if (!isNaN(d)) {
                    // Check if we should include this segment based on start/end time
                    // The segment starts at totalPlaylistDuration and ends at totalPlaylistDuration + d
                    const segStart = totalPlaylistDuration;
                    const segEnd = totalPlaylistDuration + d;
                    totalPlaylistDuration += d;
                    
                    let shouldInclude = true;
                    
                    if (segEnd <= startSeconds) shouldInclude = false; // Completely before start
                    if (endSeconds !== -1 && segStart >= endSeconds) shouldInclude = false; // Completely after end
                    
                    if (shouldInclude) {
                        calculatedDuration += d;
                        segmentDurations.push(d);
                        // Mark that we want the next URL
                        lines[i] = '#INCLUDE_NEXT'; 
                    } else {
                        lines[i] = '#SKIP_NEXT';
                    }
                }
            }

            if (line && !line.startsWith('#') && !line.startsWith('http') && !line.includes('/')) {
                 // Might be a weird line, but usually URL
            }
            
            // If the line is a URL (not starting with #), check if we marked it
            if (line && !line.startsWith('#')) {
                // We need to look back at the previous EXTINF to see if we marked it
                // But we modified lines[i] in the previous block if it was EXTINF.
                // The URL is usually at i+1 relative to EXTINF.
                // But here we are iterating i.
                
                // Let's look at the PREVIOUS line(s) to find the decision.
                // Since we modify the EXTINF line to #INCLUDE_NEXT or #SKIP_NEXT, we can check that.
                
                let prevDecision = '#INCLUDE_NEXT'; // Default to include if no EXTINF found (unlikely)
                for (let j = i - 1; j >= 0; j--) {
                    const prevLineRaw = lines[j];
                    const prevLineTrimmed = prevLineRaw.trim();
                    
                    if (!prevLineTrimmed) continue; // Skip empty lines
                    
                    if (prevLineRaw === '#INCLUDE_NEXT') {
                        prevDecision = '#INCLUDE_NEXT';
                        break;
                    }
                    if (prevLineRaw === '#SKIP_NEXT') {
                        prevDecision = '#SKIP_NEXT';
                        break;
                    }
                    if (prevLineTrimmed.startsWith('#')) continue; // Skip other comments
                    break; // Found another URL or empty line, stop
                }

                if (prevDecision === '#INCLUDE_NEXT') {
                     const resolved = line.startsWith('http') ? line : baseUrl + line;
                     if (isAllowedStreamUrl(resolved, baseStreamHost)) {
                         segments.push(resolved);
                     }
                }
            }
        }
        
        console.log(`Parsed ${segments.length} segments. Total Calculated Duration: ${calculatedDuration}s. Trim Request: ${startSeconds}-${endSeconds}`);

        // --- GHOST SEGMENT DISCOVERY ---
        // Attempt to find hidden segments not listed in the M3U8 (common issue with Kick VODs)
        // Only run if we are NOT trimming (downloading full VOD)
        if (segments.length > 0 && endSeconds === -1) {
            const lastSegmentUrl = segments[segments.length - 1];
            const lastSlashIdx = lastSegmentUrl.lastIndexOf('/');
            
            if (lastSlashIdx !== -1) {
                const baseUrlForSeg = lastSegmentUrl.substring(0, lastSlashIdx + 1);
                const fileName = lastSegmentUrl.substring(lastSlashIdx + 1);
                
                // Match number in filename (e.g. segment-59.ts or 59.ts)
                const match = fileName.match(/^(.*?)(\d+)(\.[^.?]+)(\?.*)?$/);
                if (match) {
                    const prefix = match[1];
                    let currentNum = parseInt(match[2], 10);
                    const suffix = match[3];
                    const query = match[4] || '';
                    
                    const MAX_GHOST_SEGMENTS = 50; // Try up to 50 extra segments (approx 8 mins)
                    let ghostCount = 0;
                    
                    console.log(`Attempting to discover ghost segments starting from ${currentNum + 1}...`);
                    updateButton(btn, 'Checking hidden segments...', true);

                    let consecutiveErrors = 0;
                    const MAX_CONSECUTIVE_ERRORS = 5;

                    // We need to wait for this discovery to finish before proceeding
                    // Using a loop with await is fine here
                    while (ghostCount < MAX_GHOST_SEGMENTS && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
                        currentNum++;
                        const nextSegName = `${prefix}${currentNum}${suffix}${query}`;
                        const nextSegUrl = `${baseUrlForSeg}${nextSegName}`;
                        
                        try {
                            // Use GET instead of HEAD as some CDNs block HEAD requests or return 403
                            // We don't need the full content yet, but standard fetch is safest for auth/existence check
                            if (!isAllowedStreamUrl(nextSegUrl, baseStreamHost)) {
                                consecutiveErrors++;
                                continue;
                            }

                            const checkRes = await fetch(nextSegUrl, { method: 'GET' }); // Changed HEAD to GET
                            
                            if (checkRes.ok) {
                                console.log(`Found ghost segment: ${nextSegName}`);
                                segments.push(nextSegUrl);
                                // Assume 10s duration for ghost segments (standard HLS target)
                                calculatedDuration += 10;
                                ghostCount++;
                                consecutiveErrors = 0; // Reset error count on success
                            } else {
                                console.log(`Ghost segment check failed at ${currentNum} (Status: ${checkRes.status})`);
                                consecutiveErrors++;
                            }
                        } catch (e) {
                            console.log(`Ghost segment search error at ${currentNum}:`, e);
                            consecutiveErrors++;
                        }
                    }
                    
                    if (ghostCount > 0) {
                        console.log(`Added ${ghostCount} ghost segments. New Duration: ${calculatedDuration}s`);
                        // Update UI to show we found extra content
                        const overlay = document.getElementById('kick-vod-overlay');
                        if (overlay) {
                             const sizeEl = overlay.querySelector('.size-text');
                             if (sizeEl) {
                                 const ghostMsg = document.createElement('div');
                                 ghostMsg.style.color = '#00ff00';
                                 ghostMsg.style.fontSize = '0.8em';
                                 ghostMsg.textContent = `✓ Found +${ghostCount} hidden segments / segmentos ocultos`;
                                 sizeEl.parentNode.insertBefore(ghostMsg, sizeEl.nextSibling);
                             }
                        }
                    }
                }
            }
        }
        // --- END GHOST SEGMENT DISCOVERY ---

        // Helper to format duration
        const formatDuration = (ms) => {
            const s = Math.round(ms / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };

        // Reset global mismatch variable
        window.kickVodDurationMismatch = null;

        // Use calculated duration if API duration is missing or 0
        // ALWAYS prefer calculated duration from M3U8 if available, as API duration is often inaccurate/stale
        if (calculatedDuration > 0) {
             const diff = Math.abs(videoDurationMs - calculatedDuration * 1000);
             if (diff > 10000) { // If difference is more than 10 seconds
                 console.log(`Duration mismatch! API/DOM: ${videoDurationMs}ms, M3U8: ${calculatedDuration * 1000}ms. Using M3U8 duration.`);
                 
                 // Set global variable for UI warning
                 window.kickVodDurationMismatch = {
                     api: formatDuration(videoDurationMs),
                     actual: formatDuration(calculatedDuration * 1000)
                 };
                 
                 videoDurationMs = calculatedDuration * 1000;
             } else if (!videoDurationMs || videoDurationMs === 0) {
                 videoDurationMs = calculatedDuration * 1000;
                 console.log(`Calculated duration from M3U8: ${videoDurationMs} ms`);
             }
        } else if (videoDurationMs > 0) {
            console.log(`Using API provided duration: ${videoDurationMs} ms`);
        }

        if (segments.length === 0) {
            throw new Error('No segments found');
        }

        // 2. Initialize Writable Stream or Fallback
        // (File Picker was already handled at the start of function)
        // Re-use the 'handle' variable from the function scope (argument)
        let writable = null;
        let memoryChunks = []; // Fallback for browsers without File System Access API (like Brave)
        
        try {
            if (handle) {
                // We have a handle from the user gesture at start
                currentDownloadVideoId = getVideoId(); // Track video ID for navigation detection
                writable = await handle.createWritable();
                currentWritable = writable;
            } else {
                console.warn('File System Access API not supported or Handle missing. Using IDB fallback.');
                usedIdbFallback = true;
                // Update overlay to warn user about memory usage
                const overlayH2 = document.querySelector('#kick-vod-overlay h2');
                if (overlayH2 && !overlayH2.textContent.includes('Temp Disk')) {
                     overlayH2.textContent += ' (Temp Disk Mode / Modo Disco Temporal)';
                }
                
                // Add permanent warning about Fallback usage
                const progressBarContainer = document.querySelector('.progress-bar-container');
                if (progressBarContainer && !document.querySelector('.kvd-fallback-warning')) {
                    const ramWarning = document.createElement('div');
                    ramWarning.className = 'kvd-fallback-warning'; // Add class to prevent duplicates
                    ramWarning.style.color = '#ffaa00'; // Orange warning
                    ramWarning.style.fontWeight = 'bold';
                    ramWarning.style.marginTop = '10px';
                    ramWarning.style.padding = '10px';
                    ramWarning.style.border = '1px solid #ffaa00';
                    ramWarning.style.backgroundColor = 'rgba(255, 170, 0, 0.1)';
                    ramWarning.textContent = 'ℹ️ INFO: Cache Write Mode / Modo de escritura en caché\nThe VOD may take up to double its size in your storage while downloading.\n\nEl VOD puede ocupar hasta el doble de su peso en tu almacenamiento mientras se descarga.';
                    ramWarning.style.whiteSpace = 'pre-wrap';
                    
                    progressBarContainer.parentNode.insertBefore(ramWarning, progressBarContainer.nextSibling);
                }
            }
        } catch (pickerError) {
             // User cancelled picker or other error
             isDownloading = false;
             removeOverlay();
             throw pickerError;
        }
        
        // 3. Initialize Transmuxer
        // We set keepOriginalTimestamps to false (default) to ensure the video starts at 0
        // instead of the original stream timestamp (which could be hours into the recording).
        // If Audio Only, set remux: false to separate streams and we will only capture audio
        const transmuxer = new muxjs.mp4.Transmuxer({
            keepOriginalTimestamps: false,
            remux: !isAudioOnly // If isAudioOnly is true, remux is false (separate streams)
        });

        let initSegmentWritten = false;
        // Capture first segment duration for bitrate calculation
        const firstSegmentDuration = segmentDurations.length > 0 ? segmentDurations[0] : 0;
        
        // Track IDB write promises to prevent race condition at the end
        const writePromises = [];
        // Track File System writes sequentially to prevent race conditions in Edge/Chrome
        let fileWriteChain = Promise.resolve();

        transmuxer.on('data', async (segment) => {
            // Filter: If Audio Only, ignore non-audio segments
            if (isAudioOnly) {
                if (segment.type !== 'audio') return;
                console.log('Writing Audio-Only Segment:', segment);
            }

            // Write init segment (ftyp + moov) only once
            if (!initSegmentWritten) {
                 let initSeg = new Uint8Array(segment.initSegment);
                 
                 // Calculate estimated bitrate from first segment
                 let estimatedBitrate = 0;
                 if (segment.data && segment.data.byteLength > 0 && firstSegmentDuration > 0) {
                     // Bitrate = bits / seconds
                     estimatedBitrate = Math.round((segment.data.byteLength * 8) / firstSegmentDuration);
                     console.log(`Calculated Bitrate: ${estimatedBitrate} bps (Size: ${segment.data.byteLength} bytes, Dur: ${firstSegmentDuration}s)`);
                 }

                 // Use calculated duration (from trimming logic) if available, otherwise fallback to provided
                 const targetDurationMs = (calculatedDuration > 0) ? calculatedDuration * 1000 : videoDurationMs;
                 
                 if (targetDurationMs > 0) {
                     initSeg = patchMp4Header(initSeg, targetDurationMs, estimatedBitrate);
                 } else {
                     console.warn('Invalid video duration, skipping header patch');
                 }
                 
                 if (writable) {
                     // Chain writes sequentially
                     fileWriteChain = fileWriteChain.then(() => writable.write(initSeg));
                 } else {
                     // Save to IndexedDB
                     writePromises.push(saveChunkToDB(initSeg));
                 }
                 initSegmentWritten = true;
            }
            // Write media segment (moof + mdat)
            const mediaSeg = new Uint8Array(segment.data);
            if (writable) {
                // Chain writes sequentially
                fileWriteChain = fileWriteChain.then(() => writable.write(mediaSeg));
            } else {
                // Save to IndexedDB
                writePromises.push(saveChunkToDB(mediaSeg));
            }
        });

        // 4. Download and process segments
        updateButton(btn, 'Downloading...', true, 0);
        
        console.log(`Video Data Duration: ${videoDurationMs} ms`);

        const startTime = Date.now();
        let lastProgress = 0;
        let totalBytes = 0;
        
        // Speed calculation variables
        let currentSpeed = 0;
        let lastSpeedTime = Date.now();
        let lastSpeedBytes = 0;
        let lastUiUpdate = 0;

        // Helper to format time (seconds) to MM:SS or HH:MM:SS
        const formatTime = (seconds) => {
            if (!isFinite(seconds) || seconds < 0) return '--:--';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        let consecutiveFailures = 0;
        let nextFetchIndex = 0;
        let nextProcessIndex = 0;
        const pendingSegments = new Map();
        let processError = null;
        let pendingTransmuxSegments = 0;

        const maxRetries = 20;
        const networkHint = (navigator.connection && navigator.connection.downlink) ? navigator.connection.downlink : 0;
        const adaptiveBase = networkHint >= 200 ? 20 : networkHint >= 100 ? 14 : networkHint >= 50 ? 10 : 8;
        const userCap = Number(localStorage.getItem('kvd_max_segment_connections') || adaptiveBase);
        const downloadConcurrency = Math.max(4, Math.min(24, Number.isFinite(userCap) ? userCap : adaptiveBase));
        const transmuxFlushEvery = 4;
        console.log(`[Download] Using ${downloadConcurrency} concurrent segment connections.`);

        async function fetchSegmentWithRetry(index) {
            let attempt = 0;
            while (attempt < maxRetries) {
                try {
                    if (cancelRequested) throw new Error('Download cancelled');

                    const segRes = await fetch(segments[index]);
                    if (!segRes.ok) {
                        throw new Error(`Failed to fetch segment ${index}, status: ${segRes.status}`);
                    }
                    return await segRes.arrayBuffer();
                } catch (err) {
                    if ((err.message || '').includes('Download cancelled')) throw err;

                    attempt++;
                    console.error(`Error fetching segment ${index} (Attempt ${attempt}/${maxRetries}):`, err);

                    if (attempt >= maxRetries) {
                        console.error(`Max retries reached for segment ${index}. Skipping... (Video might be glitchy)`);
                        return null;
                    }

                    const backoff = Math.min(1000 * Math.pow(1.5, attempt), 15000);
                    const jitter = Math.random() * 500;
                    const delay = backoff + jitter;

                    updateOverlay(lastProgress,
                        `Connection Issue / Problema de Conexión`,
                        `Retrying segment ${index}/${segments.length} (Attempt ${attempt}/${maxRetries})...
Waiting ${Math.round(delay / 1000)}s`,
                        totalBytes,
                        0
                    );

                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            return null;
        }

        let processChain = Promise.resolve();
        const processPendingSegments = () => {
            processChain = processChain.then(async () => {
                while (pendingSegments.has(nextProcessIndex)) {
                    if (cancelRequested) {
                        throw new Error('Download cancelled by user / Descarga cancelada por el usuario');
                    }

                    const segData = pendingSegments.get(nextProcessIndex);
                    pendingSegments.delete(nextProcessIndex);

                    if (segData) {
                        totalBytes += segData.byteLength;
                        const sourceBytes = new Uint8Array(segData);
                        const cleanBytes = new Uint8Array(sourceBytes.length);
                        cleanBytes.set(sourceBytes);

                        transmuxer.push(cleanBytes);
                        pendingTransmuxSegments++;

                        const processedCount = nextProcessIndex + 1;
                        const isLastSegment = processedCount >= segments.length;
                        if (pendingTransmuxSegments >= transmuxFlushEvery || isLastSegment) {
                            transmuxer.flush();
                            pendingTransmuxSegments = 0;
                        }
                        consecutiveFailures = 0;
                    } else {
                        consecutiveFailures++;
                    }

                    const processedCount = nextProcessIndex + 1;
                    const progress = Math.round((processedCount / segments.length) * 100);
                    const now = Date.now();
                    const timeDiff = (now - lastSpeedTime) / 1000;

                    if (timeDiff >= 1) {
                        const bytesDiff = totalBytes - lastSpeedBytes;
                        currentSpeed = bytesDiff / timeDiff;
                        lastSpeedTime = now;
                        lastSpeedBytes = totalBytes;
                    }

                    if (progress > lastProgress || (now - lastUiUpdate > 1000)) {
                        lastProgress = Math.max(lastProgress, progress);
                        lastUiUpdate = now;

                        const elapsedTime = (Date.now() - startTime) / 1000;
                        let etaText = 'Calculating time...';

                        if (elapsedTime > 2 && processedCount > 0) {
                            const rate = processedCount / elapsedTime;
                            const remainingSegments = segments.length - processedCount;
                            const etaSeconds = remainingSegments / Math.max(rate, 0.01);
                            etaText = `Estimated time remaining: ${formatTime(etaSeconds)}`;
                        }

                        updateButton(btn, 'Downloading...', true, progress);
                        updateOverlay(progress, 'Downloading VOD / Descargando VOD', etaText, totalBytes, currentSpeed);
                    }

                    if (consecutiveFailures >= 12) {
                        throw new Error('Too many consecutive download failures. Aborting to prevent looping.');
                    }

                    nextProcessIndex++;
                }
            });
            return processChain;
        };

        const worker = async () => {
            while (true) {
                if (processError) break;
                const index = nextFetchIndex;
                nextFetchIndex++;
                if (index >= segments.length) break;

                const segData = await fetchSegmentWithRetry(index);
                pendingSegments.set(index, segData);
                processPendingSegments().catch((e) => {
                    processError = e;
                });
            }
        };

        const workers = Array.from({ length: downloadConcurrency }, () => worker());
        await Promise.all(workers);
        await processPendingSegments();
        if (processError) throw processError;

        if (pendingTransmuxSegments > 0) {
            transmuxer.flush();
            pendingTransmuxSegments = 0;
        }

        if (nextProcessIndex < segments.length) {
            throw new Error('Some segments were not processed correctly.');
        }

        // 100% reached, but still writing/closing
        updateOverlay(100, 'Finalizing file writing... / Finalizando escritura del archivo...', 'Please wait / Por favor espere', totalBytes);

        if (writable) {
            // Wait for all pending writes to complete
            console.log('Waiting for pending file writes to complete...');
            await fileWriteChain;
            
            await writable.close();
            currentWritable = null;
        } else {
            // Memory fallback: Create blob and trigger download
            console.log('Finalizing memory download... reading from IDB');
            updateOverlay(100, 'Assembling video file... / Ensamblando archivo de video...', 'This may take a minute... / Esto puede tardar un minuto...', totalBytes);
            shouldClearChunks = true;
            
            // Add spinner
            const overlay = document.getElementById('kick-vod-overlay');
            if (overlay) {
                let spinner = overlay.querySelector('.kvd-spinner');
                if (!spinner) {
                    spinner = document.createElement('div');
                    spinner.className = 'kvd-spinner';
                    // Insert before text
                    const etaEl = overlay.querySelector('.eta-text');
                    if (etaEl) etaEl.parentNode.insertBefore(spinner, etaEl);
                }
            }

            // Wait for all IDB writes to complete
            if (writePromises.length > 0) {
                console.log(`Waiting for ${writePromises.length} pending writes...`);
                await Promise.all(writePromises);
            }
            
            // Read chunks from IDB
            const chunks = await getAllChunksFromDB();
            
            if (chunks.length === 0) {
                 console.error('No chunks found in IDB after download!');
                 alert('Error: Download seems empty. Please check console.');
            }
            
            let blobType = isAudioOnly ? 'audio/mp4' : 'video/mp4';
            let blob = new Blob(chunks, { type: blobType });
            let ext = isAudioOnly ? 'm4a' : 'mp4';

            if (isAudioOnly && audioOnlyFormat === 'mp3') {
                updateOverlay(100, 'Converting to MP3... / Convirtiendo a MP3...', 'This can take a while... / Esto puede tardar...', totalBytes);
                try {
                    blob = await convertM4aToMp3(blob);
                    blobType = 'audio/mpeg';
                    ext = 'mp3';
                } catch (conversionError) {
                    console.error('MP3 conversion failed, falling back to M4A:', conversionError);
                    updateOverlay(100, 'MP3 conversion failed, saving M4A... / Falló MP3, guardando M4A...', '', totalBytes);
                }
            }

            objectUrl = URL.createObjectURL(blob);
            tempLink = document.createElement('a');
            tempLink.style.display = 'none';
            tempLink.href = objectUrl;
            tempLink.download = `kick-vod-${getVideoId() || 'video'}.${ext}`;
            document.body.appendChild(tempLink);
            tempLink.click();

            // Removed manual alert and reload as requested
            // alert("When the download finishes, reload the page or close the tab.\n\nCuando la descarga finalice, recarga la página o cierra la pestaña.");
            
            // Cleanup after a short delay to allow the download to initialize
            deferObjectUrlCleanup = true;
            setTimeout(() => {
                if (tempLink && tempLink.parentNode) {
                    tempLink.parentNode.removeChild(tempLink);
                }
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                    objectUrl = null;
                }
            }, 1500);
        }
        
        sendNotification('Download Complete / Descarga Completa', `The VOD "${getVideoId() || 'video'}" has been downloaded successfully.`);
        updateButton(btn, 'Download Complete!', false);
        shouldResetState = true;
        shouldClearChunks = true;
        clearHandleFromDB();
        removeOverlay(); // Remove overlay on success
        
        // Restore audio after successful download
        restorePageAudio();

        setTimeout(() => {
             setButtonToDownload(btn);
        }, 2500);

    } catch (error) {
        // Flag cleanup on error
        shouldRemoveFile = true;
        shouldClearChunks = true;
        shouldResetState = true;

        // Restore audio on error
        restorePageAudio();

        console.error('Download failed:', error);
        
        // Only alert if it's not a user cancellation
        if (isUserCancellationError(error)) {
             updateButton(btn, 'Cancelled', false);
             console.log('Download cancelled. Cleaning up without reload...');
             setTimeout(() => setButtonToDownload(btn), 1500);
        } else {
            sendNotification('Download Failed / Error de Descarga', `Error: ${error.message}`);
            alert('Download failed: ' + error.message);
            updateButton(btn, 'Error', false);
        }
        removeOverlay();
    } finally {
        if (currentWritable) {
            try {
                await currentWritable.abort();
            } catch (_) {}
            currentWritable = null;
        }

        if (shouldRemoveFile) {
            await cleanupDownloadArtifacts({ clearChunks: false, removeFile: true });
        }

        if (shouldClearChunks || usedIdbFallback) {
            await cleanupDownloadArtifacts({ clearChunks: true, removeFile: false });
        }

        // Defensive cleanup to avoid stale chunks from interrupted sessions
        await clearChunksFromDB().catch(() => {});

        if (!deferObjectUrlCleanup && tempLink && tempLink.parentNode) {
            tempLink.parentNode.removeChild(tempLink);
        }

        if (!deferObjectUrlCleanup && objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }

        clearHandleFromDB();

        if (shouldResetState) {
            resetDownloadState();
        }
    }
}

// Function to create and show the download options modal
function createDownloadOptionsModal(videoId, durationMs, btn) {
    // Remove existing modal if any
    const existingModal = document.querySelector('.kvd-modal-overlay');
    if (existingModal) existingModal.remove();

    // Mute video to prevent audio interference while deciding
    mutePageAudio();

    const durationSeconds = Math.floor(durationMs / 1000);
    
    // Helper to format seconds to HH:MM:SS
    const formatTime = (totalSeconds) => {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = Math.floor(totalSeconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const modal = document.createElement('div');
    modal.className = 'kvd-modal-overlay';
    
    const content = document.createElement('div');
    content.className = 'kvd-modal-content';
    modal.appendChild(content);

    const title = document.createElement('div');
    title.className = 'kvd-modal-title';
    title.textContent = 'Download Options / Opciones';
    content.appendChild(title);

    // --- Quality Selector ---
    const qualityContainer = document.createElement('div');
    qualityContainer.style.cssText = 'margin-bottom: 15px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 5px;';
    
    const qualityLabel = document.createElement('label');
    qualityLabel.textContent = 'Quality / Calidad:';
    qualityLabel.style.cssText = 'color: #ccc; font-size: 14px; font-weight: bold;';
    qualityContainer.appendChild(qualityLabel);

    const qualitySelect = document.createElement('select');
    qualitySelect.id = 'kvd-quality-select';
    qualitySelect.style.cssText = 'background: #222; color: #fff; border: 1px solid #444; padding: 8px; border-radius: 4px; font-size: 14px; width: 80%; cursor: pointer; outline: none;';
    qualitySelect.innerHTML = '<option value="">Loading / Cargando...</option>';
    qualitySelect.disabled = true;
    qualityContainer.appendChild(qualitySelect);

    content.appendChild(qualityContainer);

    // State for selected URL
    let selectedVariantUrl = null;
    let masterPlaylistUrl = null;

    // Fetch Qualities Logic
    (async () => {
        try {
            // Check if we already have data from the button click? 
            // We don't have it passed here, so we fetch. It's cached usually.
            const data = await fetchVideoData(videoId);
            if (!data || !data.source) {
                qualitySelect.innerHTML = '<option value="">Error: No Source</option>';
                return;
            }
            masterPlaylistUrl = data.source;

            // Fetch Playlist
            const response = await fetch(masterPlaylistUrl);
            const text = await response.text();
            const lines = text.split('\n');

            const variants = [];
            
            // Robust Base URL calculation
            let baseUrl;
            try {
                baseUrl = new URL('.', masterPlaylistUrl).href;
            } catch (e) {
                baseUrl = masterPlaylistUrl.substring(0, masterPlaylistUrl.lastIndexOf('/') + 1);
            }

            if (text.includes('EXT-X-STREAM-INF')) {
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('EXT-X-STREAM-INF')) {
                        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                        const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                        const res = resMatch ? resMatch[1] : 'Audio Only'; // Fallback if no resolution (Audio)
                        
                        let j = i + 1;
                        while (j < lines.length && lines[j].startsWith('#')) j++;
                        if (j < lines.length && lines[j].trim().length > 0) {
                            let url = lines[j].trim();
                            // Robust URL resolution
                            if (!url.startsWith('http')) {
                                try {
                                    url = new URL(url, baseUrl).href;
                                } catch (e) {
                                    url = baseUrl + url;
                                }
                            }
                            variants.push({ bandwidth: bw, resolution: res, url: url });
                        }
                    }
                }
            }

            if (variants.length > 0) {
                // Sort: High Bandwidth first
                variants.sort((a, b) => b.bandwidth - a.bandwidth);

                qualitySelect.innerHTML = '';
                
                // Add variants
                variants.forEach((v, index) => {
                    const opt = document.createElement('option');
                    
                    const kbps = Math.round(v.bandwidth / 1000);
                    opt.textContent = `${v.resolution} (${kbps} kbps)`;
                    
                    if (index === 0) {
                        opt.textContent += ' (Best/Mejor)';
                        opt.selected = true;
                        // Use Master Playlist for "Best" to allow smart selection/fallback in downloadSegments
                        opt.value = masterPlaylistUrl; 
                        selectedVariantUrl = masterPlaylistUrl;
                    } else {
                        opt.value = v.url;
                    }
                    
                    qualitySelect.appendChild(opt);
                });
                
                // Add "Solo Audio" options
                // Uses 360p or lowest quality variant as source, strips video track
                const audioCandidate = variants.find(v => v.resolution && v.resolution.includes('360')) || variants[variants.length - 1];
                if (audioCandidate) {
                    const optMp3 = document.createElement('option');
                    optMp3.textContent = 'Solo Audio (MP3) - Experimental';
                    optMp3.value = audioCandidate.url + '#audio_only=mp3';
                    optMp3.style.color = '#53fc18'; // Highlight
                    qualitySelect.appendChild(optMp3);

                    const optM4a = document.createElement('option');
                    optM4a.textContent = 'Solo Audio (M4A)';
                    optM4a.value = audioCandidate.url + '#audio_only=m4a';
                    qualitySelect.appendChild(optM4a);
                }
                
                qualitySelect.disabled = false;
                
                // Update selected on change
                qualitySelect.onchange = () => {
                    selectedVariantUrl = qualitySelect.value;
                };

            } else {
                // No variants (single stream?)
                qualitySelect.innerHTML = '<option value="">Default (Single Stream)</option>';
                selectedVariantUrl = masterPlaylistUrl; // Fallback to master
            }

        } catch (e) {
            console.error('Error fetching qualities:', e);
            qualitySelect.innerHTML = '<option value="">Auto (Default)</option>';
            selectedVariantUrl = null; 
        }
    })();
    
    // Main Options
    const mainOptions = document.createElement('div');
    mainOptions.id = 'kvd-main-options';
    mainOptions.className = 'kvd-modal-options';
    content.appendChild(mainOptions);

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'kvd-option-btn primary';
    downloadAllBtn.id = 'kvd-download-all';
    // SVG Download
    const svgDownload = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgDownload.setAttribute('width', '24');
    svgDownload.setAttribute('height', '24');
    svgDownload.setAttribute('fill', 'none');
    svgDownload.setAttribute('viewBox', '0 0 24 24');
    svgDownload.setAttribute('stroke', 'currentColor');
    const pathDownload = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathDownload.setAttribute('stroke-linecap', 'round');
    pathDownload.setAttribute('stroke-linejoin', 'round');
    pathDownload.setAttribute('stroke-width', '2');
    pathDownload.setAttribute('d', 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4');
    svgDownload.appendChild(pathDownload);
    downloadAllBtn.appendChild(svgDownload);
    downloadAllBtn.appendChild(document.createTextNode(' Download Full VOD / Descargar Todo'));
    mainOptions.appendChild(downloadAllBtn);

    const trimOptionBtn = document.createElement('button');
    trimOptionBtn.className = 'kvd-option-btn';
    trimOptionBtn.id = 'kvd-trim-option';
    // SVG Trim
    const svgTrim = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgTrim.setAttribute('width', '24');
    svgTrim.setAttribute('height', '24');
    svgTrim.setAttribute('fill', 'none');
    svgTrim.setAttribute('viewBox', '0 0 24 24');
    svgTrim.setAttribute('stroke', 'currentColor');
    const pathTrim = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathTrim.setAttribute('stroke-linecap', 'round');
    pathTrim.setAttribute('stroke-linejoin', 'round');
    pathTrim.setAttribute('stroke-width', '2');
    pathTrim.setAttribute('d', 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm8.486-8.486a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243z');
    svgTrim.appendChild(pathTrim);
    trimOptionBtn.appendChild(svgTrim);
    trimOptionBtn.appendChild(document.createTextNode(' Trim / Recortar'));
    mainOptions.appendChild(trimOptionBtn);

    // Trim UI
    const trimUI = document.createElement('div');
    trimUI.id = 'kvd-trim-ui';
    trimUI.className = 'kvd-trim-container';
    content.appendChild(trimUI);

    const timeInputs = document.createElement('div');
    timeInputs.className = 'kvd-time-inputs';
    trimUI.appendChild(timeInputs);

    // Start Group
    const startGroup = document.createElement('div');
    startGroup.className = 'kvd-time-group';
    timeInputs.appendChild(startGroup);
    
    const startLabel = document.createElement('span');
    startLabel.className = 'kvd-time-label';
    startLabel.textContent = 'Start / Inicio';
    startGroup.appendChild(startLabel);

    const startTimeInput = document.createElement('input');
    startTimeInput.type = 'text';
    startTimeInput.className = 'kvd-time-input';
    startTimeInput.id = 'kvd-start-time';
    startTimeInput.value = '00:00:00';
    startTimeInput.placeholder = 'HH:MM:SS';
    startGroup.appendChild(startTimeInput);

    const startSlider = document.createElement('input');
    startSlider.type = 'range';
    startSlider.id = 'kvd-start-slider';
    startSlider.className = 'kvd-range-slider';
    startSlider.min = '0';
    startSlider.max = durationSeconds;
    startSlider.value = '0';
    startSlider.step = '10';
    startGroup.appendChild(startSlider);

    // End Group
    const endGroup = document.createElement('div');
    endGroup.className = 'kvd-time-group';
    timeInputs.appendChild(endGroup);

    const endLabel = document.createElement('span');
    endLabel.className = 'kvd-time-label';
    endLabel.textContent = `End / Fin (Max: ${formatTime(durationSeconds)})`;
    endGroup.appendChild(endLabel);

    const endTimeInput = document.createElement('input');
    endTimeInput.type = 'text';
    endTimeInput.className = 'kvd-time-input';
    endTimeInput.id = 'kvd-end-time';
    endTimeInput.value = formatTime(durationSeconds);
    endTimeInput.placeholder = 'HH:MM:SS';
    endGroup.appendChild(endTimeInput);

    const endSlider = document.createElement('input');
    endSlider.type = 'range';
    endSlider.id = 'kvd-end-slider';
    endSlider.className = 'kvd-range-slider';
    endSlider.min = '0';
    endSlider.max = durationSeconds;
    endSlider.value = durationSeconds;
    endSlider.step = '10';
    endGroup.appendChild(endSlider);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'kvd-hint';
    hint.style.cssText = 'font-size: 0.8em; color: #888; margin-top: -10px; margin-bottom: 15px; text-align: center;';
    hint.textContent = 'Selection snaps to ~10s segments / Selección ajustada a segmentos de ~10s';
    trimUI.appendChild(hint);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'kvd-actions';
    trimUI.appendChild(actions);

    const backBtn = document.createElement('button');
    backBtn.className = 'kvd-btn-small kvd-btn-cancel';
    backBtn.id = 'kvd-back-btn';
    backBtn.textContent = 'Back / Volver';
    actions.appendChild(backBtn);

    const startTrimBtn = document.createElement('button');
    startTrimBtn.className = 'kvd-btn-small kvd-btn-confirm';
    startTrimBtn.id = 'kvd-start-trim';
    startTrimBtn.textContent = 'Download / Descargar';
    actions.appendChild(startTrimBtn);

    // Close Modal Button
    const closeModalBtn = document.createElement('button');
    closeModalBtn.className = 'kvd-btn-small kvd-btn-cancel';
    closeModalBtn.id = 'kvd-close-modal';
    closeModalBtn.style.marginTop = '10px';
    closeModalBtn.textContent = 'Cancel / Cancelar';
    content.appendChild(closeModalBtn);

    document.body.appendChild(modal);

    // Helper to parse HH:MM:SS to seconds
    const parseTime = (timeStr) => {
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    };

    // Sync Logic
    const syncInputToSlider = (input, slider) => {
        const seconds = parseTime(input.value);
        if (!isNaN(seconds)) {
             // Snap to nearest 10
             const snapped = Math.round(seconds / 10) * 10;
             slider.value = snapped;
        }
    };

    const syncSliderToInput = (slider, input) => {
        const seconds = parseInt(slider.value, 10);
        input.value = formatTime(seconds);
    };

    // Listeners for Sliders
    startSlider.addEventListener('input', () => {
        if (parseInt(startSlider.value) >= parseInt(endSlider.value)) {
             startSlider.value = parseInt(endSlider.value) - 10;
        }
        syncSliderToInput(startSlider, startTimeInput);
    });

    endSlider.addEventListener('input', () => {
        if (parseInt(endSlider.value) <= parseInt(startSlider.value)) {
             endSlider.value = parseInt(startSlider.value) + 10;
        }
        syncSliderToInput(endSlider, endTimeInput);
    });

    // Listeners for Text Inputs (Blur to snap)
    startTimeInput.addEventListener('change', () => syncInputToSlider(startTimeInput, startSlider));
    endTimeInput.addEventListener('change', () => syncInputToSlider(endTimeInput, endSlider));
    startTimeInput.addEventListener('blur', () => {
         syncInputToSlider(startTimeInput, startSlider);
         syncSliderToInput(startSlider, startTimeInput); // Update text to snapped value
    });
    endTimeInput.addEventListener('blur', () => {
         syncInputToSlider(endTimeInput, endSlider);
         syncSliderToInput(endSlider, endTimeInput); // Update text to snapped value
    });

    // Close Modal
    const close = () => {
        modal.remove();
        btn.disabled = false;
        btn.textContent = 'Download'; // Simplified text
        setButtonToDownload(btn); // Re-apply SVG and correct structure
        
        // Restore audio if download NOT started
        restorePageAudio();
    };

    closeModalBtn.onclick = close;
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };

    // Download All
    downloadAllBtn.onclick = async () => {
        modal.remove();
        // Do NOT restore audio here, downloadSegments handles it after download finishes
        
        let sourceUrl = selectedVariantUrl;
        
        if (!sourceUrl) {
            // Fallback if selector failed or logic didn't run
            const videoData = await fetchVideoData(videoId);
            if (videoData) sourceUrl = videoData.source;
        }

        if (sourceUrl) {
             await downloadSegments(sourceUrl, btn, durationMs, 0, -1, null, false, videoId);
        } else {
             alert('Could not fetch video source');
             btn.disabled = false;
             restorePageAudio(); // Restore if error
        }
    };

    // Show Trim UI
    trimOptionBtn.onclick = () => {
        mainOptions.style.display = 'none';
        trimUI.style.display = 'block';
        closeModalBtn.style.display = 'none'; // Hide main cancel, use back/cancel in trim UI
    };

    // Back to Main Options
    backBtn.onclick = () => {
        trimUI.style.display = 'none';
        mainOptions.style.display = 'flex';
        closeModalBtn.style.display = 'inline-block';
    };

    // Start Trim Download
    startTrimBtn.onclick = async () => {
        const startStr = modal.querySelector('#kvd-start-time').value;
        const endStr = modal.querySelector('#kvd-end-time').value;
        
        const startSeconds = parseTime(startStr);
        const endSeconds = parseTime(endStr);

        if (startSeconds >= endSeconds) {
            alert('Start time must be before End time / El inicio debe ser anterior al final');
            return;
        }

        if (endSeconds > durationSeconds + 120) { // Allow some buffer
            alert('End time exceeds video duration / El final excede la duración del video');
            return;
        }

        modal.remove();
        
        let sourceUrl = selectedVariantUrl;
        
        if (!sourceUrl) {
            const videoData = await fetchVideoData(videoId);
            if (videoData) sourceUrl = videoData.source;
        }
        
        if (sourceUrl) {
             // Pass start/end in seconds
             await downloadSegments(sourceUrl, btn, durationMs, startSeconds, endSeconds, null, false, videoId);
        } else {
             alert('Could not fetch video source');
             btn.disabled = false;
             restorePageAudio(); // Restore if error
        }
    };
}

// --- STREAMER MODE (AUTO-DOWNLOAD) ---
let isStreamerModeEnabled = false;
let streamEndDetected = false;
let lastHostRejection = 0;

function findHostRejectButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const textMatches = (text) => {
        const cleaned = text.toLowerCase();
        return cleaned.includes('rechazar') || cleaned.includes('reject') || cleaned.includes('decline');
    };

    return candidates.find(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const title = btn.getAttribute('title') || '';
        const text = btn.textContent || '';
        return textMatches(label) || textMatches(title) || textMatches(text);
    });
}

function attemptRejectHost() {
    if (!isStreamerModeEnabled) return;
    const now = Date.now();
    if (now - lastHostRejection < 2000) return;
    const rejectBtn = findHostRejectButton();
    if (rejectBtn && !rejectBtn.disabled) {
        rejectBtn.click();
        lastHostRejection = now;
        console.log('[KVD] Host rejected while Auto-DL active.');
    }
}

function isModerator() {
    // Dashboard: Always true (Access restricted to mods/streamers anyway)
    if (window.location.hostname === 'dashboard.kick.com') {
        return true;
    }
    const slug = getChannelSlug();
    const adminChannels = JSON.parse(localStorage.getItem('kvd_admin_channels') || '[]');
    return !!document.querySelector('a[href*="/moderator"]') || adminChannels.includes(slug);
}

function getChannelSlug() {
    // Dashboard support: /moderator/slug
    if (window.location.hostname === 'dashboard.kick.com') {
        const match = window.location.pathname.match(/\/moderator\/([^\/]+)/);
        if (match) return match[1];
    }

    const parts = window.location.pathname.split('/').filter(p => p);
    if (parts.length === 1 && parts[0] !== 'video' && parts[0] !== 'videos') {
        return parts[0];
    }
    return null;
}

// Check for pending auto-download on load (Post-Reload Logic)
async function checkPendingAutoDownloadTrigger() {
    if (localStorage.getItem('kvd_auto_dl_pending') === 'true') {
        if (localStorage.getItem('kvd_auto_dl_enabled') !== 'true') {
            console.log('[Streamer Mode] Pending Auto-DL cleared because toggler is disabled.');
            localStorage.removeItem('kvd_auto_dl_pending');
            localStorage.removeItem('kvd_channel_slug');
            return;
        }

        console.log('[Streamer Mode] Pending auto-download detected. Starting process...');
        localStorage.removeItem('kvd_auto_dl_pending');
        
        const slug = localStorage.getItem('kvd_channel_slug') || getChannelSlug();
        if (!slug) return;

        // Floating Status UI
        const statusDiv = document.createElement('div');
        statusDiv.style.cssText = 'position: fixed; top: 80px; right: 20px; background: rgba(0,0,0,0.9); color: #53fc18; padding: 20px; border-radius: 8px; z-index: 99999; font-family: "Inter", sans-serif; border: 2px solid #53fc18; box-shadow: 0 0 20px rgba(83, 252, 24, 0.3); font-size: 14px; max-width: 300px;';
        statusDiv.innerHTML = '<strong>🚀 Auto-DL Active</strong><br>Waiting for VOD generation (2m)...<br>Esperando generación del VOD (2m)...';
        document.body.appendChild(statusDiv);

        // Wait 2 minutes for VOD to be generated by Kick backend
        await new Promise(resolve => {
            let secondsLeft = 120;
            const timer = setInterval(() => {
                secondsLeft--;
                statusDiv.innerHTML = `<strong>🚀 Auto-DL Active</strong><br>Waiting for VOD generation...<br>Esperando generación del VOD...<br>⏱️ ${secondsLeft}s`;
                if (secondsLeft <= 0) {
                    clearInterval(timer);
                    resolve();
                }
            }, 1000);
        });

        statusDiv.innerHTML = '<strong>🚀 Auto-DL Active</strong><br>Searching for latest VOD...<br>Buscando último VOD...';

        try {
            // Fetch Channel API to find UUID
            const response = await fetch(`https://kick.com/api/v1/channels/${slug}`);
            if (!response.ok) throw new Error('Channel API failed');
            
            const data = await response.json();
            const previousStreams = data.previous_livestreams;
            
            if (previousStreams && previousStreams.length > 0) {
                const latestStream = previousStreams[0];
                const videoId = latestStream.video.uuid; // Use UUID
                
                statusDiv.innerHTML = `<strong>🚀 Auto-DL Active</strong><br>VOD Found! (${videoId})<br>Getting Metadata...`;
                
                const videoData = await fetchVideoData(videoId);
                if (videoData && videoData.source) {
                    statusDiv.innerHTML = '<strong>🚀 Auto-DL Active</strong><br>Starting Download...<br>Iniciando Descarga...';
                    
                    // Dummy button for downloader
                    const dummyBtn = document.createElement('button');
                    dummyBtn.style.display = 'none';
                    document.body.appendChild(dummyBtn);

                    // Start Download with pre-selected save handle (picked when Auto-DL was enabled)
                    const preOpenedHandle = await getHandleFromDB();
                    if (!preOpenedHandle) {
                        throw new Error('Missing preselected save file. Re-enable Auto-DL and choose a destination file.');
                    }

                    await downloadSegments(videoData.source, dummyBtn, videoData.duration, 0, -1, preOpenedHandle, false, videoId);

                    statusDiv.innerHTML = '<strong>✅ Auto-DL finished!</strong><br>Latest VOD downloaded at max quality.<br>Último VOD descargado en máxima calidad.';
                    setTimeout(() => statusDiv.remove(), 8000);
                } else {
                    throw new Error('Video source not found');
                }
            } else {
                throw new Error('No VODs found in API');
            }
        } catch (e) {
            console.error('[Streamer Mode] Error:', e);
            statusDiv.innerHTML = `<strong>❌ Auto-DL Error</strong><br>${e.message}`;
            statusDiv.style.color = '#ff4444';
            statusDiv.style.borderColor = '#ff4444';

            // If user disabled Auto-DL while pending flow was running, clean stale state too
            if (localStorage.getItem('kvd_auto_dl_enabled') !== 'true') {
                localStorage.removeItem('kvd_auto_dl_pending');
                localStorage.removeItem('kvd_channel_slug');
            }
        }
    }
}

// Initialize check
checkPendingAutoDownloadTrigger();

// Protection against accidental navigation/host redirects
function handleStreamerModeExit(e) {
    if (isStreamerModeEnabled && !streamEndDetected) {
        e.preventDefault();
        e.returnValue = 'Auto-Download is active. If you leave, it will be cancelled.\n\nLa Auto-Descarga está activa. Si sales, se cancelará.';
        return e.returnValue;
    }
}

// Inject Host Protection Script (SPA Navigation Blocker)
function injectHostProtectionScript() {
    if (document.getElementById('kvd-host-protection-script')) return;

    const script = document.createElement('script');
    script.id = 'kvd-host-protection-script';
    script.textContent = `
        (function() {
            const originalPush = history.pushState;
            const originalReplace = history.replaceState;

            function shouldBlock() {
                return document.body.getAttribute('data-kvd-auto-dl') === 'true';
            }

            history.pushState = function(...args) {
                if (shouldBlock()) {
                    console.log('[KVD Protection] Blocked history.pushState navigation (Host/Redirect prevented)');
                    return; // Block navigation
                }
                return originalPush.apply(this, args);
            };

            history.replaceState = function(...args) {
                if (shouldBlock()) {
                    console.log('[KVD Protection] Blocked history.replaceState navigation (Host/Redirect prevented)');
                    return; // Block navigation
                }
                return originalReplace.apply(this, args);
            };
            
            console.log('[KVD] Host Protection Script Injected');
        })();
    `;
    (document.head || document.documentElement).appendChild(script);
}

function injectStreamerModeUI() {
    // Inject Protection Script immediately
    injectHostProtectionScript();

    // Check if already injected
    if (document.getElementById('kvd-streamer-container')) return;

    let target = null;
    let insertPosition = 'after'; // 'after' or 'before' or 'append'

    // Strategy 1: Dashboard Injection (Navbar)
    if (window.location.hostname === 'dashboard.kick.com') {
        // Look for the sticky navbar
        const navbar = document.querySelector('nav.sticky.top-0');
        if (navbar) {
            // Center in navbar using absolute positioning
            target = navbar;
            insertPosition = 'append';

            // --- VOD Button Injection (Dashboard Only) ---
            if (!document.getElementById('kvd-dashboard-vod-btn') && navbar.children.length > 0) {
                // Find right container (usually the last child)
                const rightContainer = navbar.children[navbar.children.length - 1];
                
                if (rightContainer) {
                     // Try to find the profile button (usually the last button or contains an image)
                     const profileBtn = Array.from(rightContainer.querySelectorAll('button')).find(btn => btn.querySelector('img'));
                     
                     if (profileBtn) {
                         const slug = getChannelSlug();
                         if (slug) {
                             const vodBtn = document.createElement('a');
                             vodBtn.id = 'kvd-dashboard-vod-btn';
                             vodBtn.href = `https://kick.com/${slug}/videos`;
                             vodBtn.target = '_blank';
                             vodBtn.title = 'Go to VODs / Ir a VODs';
                             // Classes from Roadmap Line 26 + hover
                             vodBtn.className = 'group relative box-border flex shrink-0 grow-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded font-semibold ring-0 transition-all focus-visible:outline-none active:scale-[0.95] disabled:pointer-events-none [&_svg]:size-[1em] state-layer-surface bg-transparent text-white [&_svg]:fill-current hover:bg-surface-hover size-10 text-base leading-none';
                             vodBtn.style.cssText = 'margin-right: 5px; text-decoration: none;';
                             
                             // Video Icon
                             vodBtn.innerHTML = `
                                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                     <path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                                 </svg>
                             `;
                             
                             rightContainer.insertBefore(vodBtn, profileBtn);
                         }
                     }
                }
            }
        }
    } 
    // Strategy 2: Channel Page Injection (Search Bar)
    else {
        // Find Target: Search Bar Container (Top Nav)
        // Strategy: Find input with placeholder 'Search' or 'Buscar'
        const inputs = Array.from(document.querySelectorAll('input'));
        const searchInput = inputs.find(i => 
            i.placeholder && (i.placeholder.includes('Search') || i.placeholder.includes('Buscar'))
        );

        if (searchInput) {
            // Go up to find the main flex container of the search bar
            let parent = searchInput.parentElement;
            // Try to find a parent that is likely the container (e.g., div with flex)
            // Usually Kick's search is wrapped in a relative div, then a flex container
            if (parent && parent.parentElement) {
                target = parent.parentElement;
                insertPosition = 'after';
            }
        }
    }

    if (!target) return; // Retry later if not found

    // console.log('[Streamer Mode] Injecting UI next to search bar...');

    const container = document.createElement('div');
    container.id = 'kvd-streamer-container';
    
    // Style logic based on location
    if (window.location.hostname === 'dashboard.kick.com') {
         // Absolute centering for Dashboard
         container.style.cssText = 'display: none; position: absolute; left: 50%; transform: translateX(-50%); align-items: center; gap: 8px; z-index: 50;';
    } else {
         // Flex flow for Channel Page
         container.style.cssText = 'display: none; align-items: center; margin-left: 15px; margin-right: 15px; gap: 8px; z-index: 50;';
    }
    
    let toggle = null;
    let knob = null;
    let label = null;

    if (window.location.hostname === 'dashboard.kick.com') {
        const button = document.createElement('button');
        button.id = 'kvd-streamer-toggle';
        button.type = 'button';
        button.title = 'Auto-download latest VOD when stream ends';
        button.textContent = 'Auto-DL';
        button.style.cssText = 'background: #1a1a1a; color: #ccc; border: 2px solid #555; border-radius: 999px; padding: 6px 14px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 5px rgba(0,0,0,0.5);';
        container.appendChild(button);
        toggle = button;
    } else {
        // Toggle Switch
        toggle = document.createElement('div');
        toggle.id = 'kvd-streamer-toggle';
        toggle.title = 'Auto-download latest VOD when stream ends (Reloads page)';
        toggle.style.cssText = 'width: 44px; height: 24px; background: #1a1a1a; border-radius: 12px; position: relative; cursor: pointer; border: 2px solid #555; transition: all 0.3s ease; box-shadow: 0 2px 5px rgba(0,0,0,0.5);';
        
        knob = document.createElement('div');
        knob.id = 'kvd-streamer-knob';
        knob.style.cssText = 'width: 16px; height: 16px; background: #fff; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);';
        
        toggle.appendChild(knob);
        
        // Label
        label = document.createElement('span');
        label.textContent = 'Auto-DL';
        label.style.cssText = 'font-size: 13px; font-weight: 700; color: #ccc; user-select: none;';
        
        container.appendChild(toggle);
        container.appendChild(label);
    }
    
    // Insert based on position strategy
    if (insertPosition === 'before') {
        target.parentNode.insertBefore(container, target);
    } else if (insertPosition === 'after') {
        if (target.nextSibling) {
            target.parentNode.insertBefore(container, target.nextSibling);
        } else {
            target.parentNode.appendChild(container);
        }
    } else { // append
        target.appendChild(container);
    }
    
    const clearAutoDLPersistentState = () => {
        localStorage.removeItem('kvd_auto_dl_pending');
        localStorage.removeItem('kvd_channel_slug');
        localStorage.removeItem('kvd_auto_dl_carry_over');
        localStorage.removeItem('kvd_auto_dl_enabled');
        clearHandleFromDB();
    };

    // Event
    const enableAutoDL = async (saveHandle) => {
        if (!saveHandle) {
            alert('Auto-DL needs a destination file selected first. / Auto-DL necesita un archivo destino primero.');
            return false;
        }

        await saveHandleToDB(saveHandle);

        isStreamerModeEnabled = true;
        preventTabInactivity(); // Prevent tab sleep
        
        // Enable Host Protection (Standard)
        window.addEventListener('beforeunload', handleStreamerModeExit);
        
        // Enable Host Protection (SPA - History API Patch)
        document.body.setAttribute('data-kvd-auto-dl', 'true');
        
        toggle.style.background = 'rgba(83, 252, 24, 0.2)';
        toggle.style.borderColor = '#53fc18';
        toggle.style.boxShadow = '0 0 10px rgba(83, 252, 24, 0.4)';
        toggle.classList.add('kvd-pulse-active');
        
        if (knob) {
            knob.style.transform = 'translateX(20px)';
            knob.style.background = '#53fc18';
        }
        if (label) {
            label.style.color = '#53fc18';
        }

        streamEndDetected = false;
        localStorage.setItem('kvd_auto_dl_enabled', 'true');
        return true;
    };

    const disableAutoDL = () => {
        isStreamerModeEnabled = false;
        allowTabInactivity();
        
        // Disable Host Protection
        window.removeEventListener('beforeunload', handleStreamerModeExit);
        document.body.removeAttribute('data-kvd-auto-dl');
        
        toggle.style.background = '#1a1a1a';
        toggle.style.borderColor = '#555';
        toggle.style.boxShadow = 'none';
        toggle.classList.remove('kvd-pulse-active');
        
        if (knob) {
            knob.style.transform = 'translateX(0)';
            knob.style.background = '#fff';
        }
        if (label) {
            label.style.color = '#ccc';
        }
        
        streamEndDetected = false;
        clearAutoDLPersistentState();
    };

    toggle.onclick = async () => {
        if (!isStreamerModeEnabled) {
            // Check if we are on Dashboard
            if (window.location.hostname === 'dashboard.kick.com') {
                const slug = getChannelSlug();
                if (slug) {
                    if (!window.showSaveFilePicker) {
                        alert('Your browser does not support file pre-selection for Auto-DL. / Tu navegador no soporta preselección de archivo para Auto-DL.');
                        return;
                    }

                    let handle = null;
                    try {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        handle = await window.showSaveFilePicker({
                            suggestedName: `kick-vod-auto-${slug}-${timestamp}.mp4`,
                            types: [{
                                description: 'MP4 Video',
                                accept: { 'video/mp4': ['.mp4'] }
                            }]
                        });
                    } catch (pickerError) {
                        console.log('[Streamer Mode] Dashboard save picker cancelled:', pickerError);
                        return;
                    }

                    await saveHandleToDB(handle);
                    localStorage.setItem('kvd_auto_dl_enabled', 'true');
                    localStorage.setItem('kvd_auto_dl_carry_over', 'true');
                    window.location.href = `https://kick.com/${slug}`;
                } else {
                    alert('Error: Could not determine channel slug.');
                }
                return;
            }

            // Normal Channel Page Activation
            if (confirm('⚠️ ENABLE AUTO-DOWNLOAD?\n\n• When "Offline" is detected, the page will RELOAD IMMEDIATELY.\n• The system will wait 2 MINUTES for VOD generation.\n• Then it will automatically download the latest VOD.\n• Host/Redirect Protection will be ACTIVE.\n• You will choose the destination file NOW so no prompt appears later.\n\n¿ACTIVAR AUTO-DESCARGA?\n• Al detectar "Offline", la página se RECARGARÁ INMEDIATAMENTE.\n• El sistema esperará 2 MINUTOS para la generación del VOD.\n• Luego descargará automáticamente el último VOD.\n• Protección contra Host/Redirección estará ACTIVA.\n• Elegirás el archivo destino AHORA para evitar prompts luego.')) {
                if (!window.showSaveFilePicker) {
                    alert('Your browser does not support file pre-selection for Auto-DL. / Tu navegador no soporta preselección de archivo para Auto-DL.');
                    return;
                }

                let handle = null;
                try {
                    const slug = getChannelSlug() || 'channel';
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    handle = await window.showSaveFilePicker({
                        suggestedName: `kick-vod-auto-${slug}-${timestamp}.mp4`,
                        types: [{
                            description: 'MP4 Video',
                            accept: { 'video/mp4': ['.mp4'] }
                        }]
                    });
                } catch (pickerError) {
                    console.log('[Streamer Mode] Save picker cancelled:', pickerError);
                    return;
                }

                await enableAutoDL(handle);
            }
        } else {
            disableAutoDL();
        }
    };

    // Check for Carry-Over State (Redirected from Dashboard)
    if (localStorage.getItem('kvd_auto_dl_carry_over') === 'true') {
        localStorage.removeItem('kvd_auto_dl_carry_over');
        (async () => {
            const carryHandle = await getHandleFromDB();
            if (!carryHandle) {
                console.warn('[Streamer Mode] Carry-over had no preselected file. Auto-DL activation skipped.');
                localStorage.removeItem('kvd_auto_dl_enabled');
                return;
            }

            await enableAutoDL(carryHandle);
            console.log('[Streamer Mode] Auto-DL enabled via Dashboard redirect.');
        })();
    }
}

function isOfflineVisible() {
    const structuredOfflinePanel = Array.from(document.querySelectorAll('div.z-player')).find((el) => {
        const badge = el.querySelector('.bg-surfaceInverse-base');
        const headline = el.querySelector('h2');
        if (!badge || !headline) return false;

        // Language-agnostic: rely on the panel structure/classnames instead of text content
        const hasLayout = el.classList.contains('absolute')
            && el.classList.contains('bg-surface-base');
        const badgeLooksLikeStatus = badge.classList.contains('uppercase')
            && badge.classList.contains('text-sm');

        return hasLayout && badgeLooksLikeStatus;
    });

    if (structuredOfflinePanel) return true;

    // Fallback (still language-agnostic): known status badge class rendered while stream is offline
    const offlineBadge = document.querySelector('div.z-player .bg-surfaceInverse-base.text-surfaceInverse-onInverse');
    return !!offlineBadge;
}

function checkStreamStatus() {
    if (!isStreamerModeEnabled || streamEndDetected) return;

    if (isOfflineVisible()) {
        streamEndDetected = true;
        console.log('[Streamer Mode] Stream went offline. Triggering Reload & Auto-DL...');
        
        // Hide UI immediately
        const container = document.getElementById('kvd-streamer-container');
        if (container) container.style.display = 'none';
        
        // Set Persistence Flags
        localStorage.setItem('kvd_auto_dl_pending', 'true');
        const slug = getChannelSlug();
        if (slug) localStorage.setItem('kvd_channel_slug', slug);

        // Reload Page
        window.location.reload();
    }
}

// Function to create the download button

function createDownloadButton() {
    if (document.querySelector('.kick-vod-download-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'kick-vod-download-btn';
    setButtonToDownload(btn);

    btn.addEventListener('click', async () => {
        if (isDownloading) {
            alert('Download in progress / Descarga en curso');
            return;
        }

        const videoId = getVideoId();
        if (!videoId) {
            alert('Could not find Video ID');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Loading Options...';

        // Fetch basic info for duration (needed for Trim UI)
        // We do a quick fetch here just to get metadata. The actual download fetch happens later.
        const data = await fetchVideoData(videoId);
        
        let durationMs = 0;
        if (data && data.duration) {
            durationMs = data.duration;
        } else {
            // Fallback: Try to get duration from DOM video element
            const videoEl = document.querySelector('video');
            if (videoEl && !isNaN(videoEl.duration) && videoEl.duration > 0) {
                durationMs = Math.round(videoEl.duration * 1000);
                console.log('Using DOM duration for modal:', durationMs);
            }
        }
        
        if (durationMs > 0) {
            createDownloadOptionsModal(videoId, durationMs, btn);
        } else {
            // Fallback to direct download if metadata fails (rare)
            if (data && data.source) {
                await downloadSegments(data.source, btn, 0, 0, -1);
            } else {
                alert('Could not find video source.');
                btn.disabled = false;
                setButtonToDownload(btn);
            }
        }
    });

    return btn;
}

// Function to inject download buttons into VOD thumbnails
function injectThumbnailButtons() {
    // Find all anchor tags that might be VODs
    // Exclude existing buttons to avoid double injection
    const links = document.querySelectorAll('a[href*="/video/"]:not(.kvd-processed), a[href*="/videos/"]:not(.kvd-processed)');
    
    links.forEach(link => {
        const href = link.getAttribute('href');
        // Extract ID
        // Regex for UUID
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const match = href.match(uuidRegex);
        
        if (match) {
            const videoId = match[0];
            
            // Check if it's really a thumbnail (contains an image or video preview)
            // This prevents adding buttons to text links
            // Also check if we already injected a button manually (double check)
            if ((link.querySelector('img') || link.querySelector('video') || link.querySelector('.bg-gray-900')) && !link.querySelector('.kvd-thumb-btn')) {
                
                link.classList.add('kvd-processed');
                // Ensure relative positioning for absolute child
                if (getComputedStyle(link).position === 'static') {
                     link.style.position = 'relative';
                }
                
                const btn = document.createElement('button');
                btn.className = 'kvd-thumb-btn';
                // Inner HTML structure with separate text span for hover effect
                btn.innerHTML = '<span>⬇</span><span class="kvd-btn-text">Download</span>'; 
                btn.title = 'Download VOD';
                
                // Navigate to video page and trigger download
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (isDownloading) {
                        alert('Download in progress / Descarga en curso');
                        return;
                    }

                    // Use sessionStorage to pass the auto-download flag
                    // This is cleaner than URL parameters and survives the navigation
                    sessionStorage.setItem('kvd_auto_download', 'true');
                    sessionStorage.setItem('kvd_auto_download_id', videoId);
                    
                    // Navigate to the video
                    window.location.href = href;
                });
                
                link.appendChild(btn);
            }
        }
    });
}

// Function to inject the button into the DOM
function injectButton() {
    if (document.querySelector('.kick-vod-download-btn')) return;

    let target = null;
    let floatingMode = false;

    console.log('Kick VOD Downloader: Attempting injection...');

    // 1. Estrategia Preferida: Botón Share/Compartir
    const shareBtn = Array.from(document.querySelectorAll('button')).find(b => 
        (b.textContent && (b.textContent.includes('Share') || b.textContent.includes('Compartir'))) ||
        (b.getAttribute('aria-label') && (b.getAttribute('aria-label').includes('Share') || b.getAttribute('aria-label').includes('Compartir')))
    );

    if (shareBtn) {
        target = shareBtn.parentNode;
        console.log('Kick VOD Downloader: Found Share button container');
    }

    // 2. Estrategia Secundaria: Títulos o selectores específicos
    if (!target) {
        const selectors = [
            'h1', // Título del video suele ser h1
            '.stream-username', 
            '.vjs-control-bar', // Barra de controles del video (arriesgado pero útil)
            'div[class*="actions"]'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                target = el.parentNode;
                console.log(`Kick VOD Downloader: Found selector ${sel}`);
                break;
            }
        }
    }

    // 3. Estrategia Fallback: Modo Flotante
    // Si no encontramos dónde ponerlo "bonito", lo ponemos flotante
    if (!target) {
        console.log('Kick VOD Downloader: No target found, using FLOATING mode');
        target = document.body;
        floatingMode = true;
    }

    if (target) {
        const btn = createDownloadButton();
        if (floatingMode) {
            btn.classList.add('floating-mode');
            document.body.appendChild(btn);
        } else {
            // Intentar insertar después del botón de share si es posible, si no al final
            if (shareBtn && shareBtn.nextSibling) {
                target.insertBefore(btn, shareBtn.nextSibling);
            } else {
                target.appendChild(btn);
            }
        }
        console.log('Kick VOD Downloader: Button injected successfully');
    }
}

// Check if we need to auto-trigger download from thumbnail click
function checkThumbnailAutoDownloadTrigger() {
    const autoDl = sessionStorage.getItem('kvd_auto_download');
    if (!autoDl) return;

    const targetId = sessionStorage.getItem('kvd_auto_download_id');
    const currentId = getVideoId();

    if (currentId && targetId === currentId) {
        const btn = document.querySelector('.kick-vod-download-btn');
        if (btn && !btn.disabled) {
            console.log('Kick VOD Downloader: Auto-triggering download for ID:', currentId);
            // Clear flags immediately
            sessionStorage.removeItem('kvd_auto_download');
            sessionStorage.removeItem('kvd_auto_download_id');
            
            btn.click();
        }
    }
}

let globalCheckCycle = 0;

// Persistencia: Comprobar cada segundo si el botón sigue ahí
// Esto es necesario porque Kick es una SPA agresiva que regenera el DOM
setInterval(() => {
    globalCheckCycle++;
    if (globalCheckCycle > 100) globalCheckCycle = 1; // Reset counter

    const currentId = getVideoId();

    // Inject button first if needed (Every 3 seconds)
    if ((globalCheckCycle % 3 === 0) && currentId && !document.querySelector('.kick-vod-download-btn')) {
        injectButton();
    }

    // Check for auto-download trigger from thumbnail (Every 1s - Critical)
    checkThumbnailAutoDownloadTrigger();

    // Navigation detection (Every 1s - Critical)
    if (currentDownloadVideoId && currentId && currentId !== currentDownloadVideoId) {
        console.log('Navigation detected! Cancelling download...');
        cancelRequested = true;
        handleUnload();
    }

    // --- Streamer Mode (Auto-DL) Management ---
    // UI Injection (Every 2 seconds)
    if (globalCheckCycle % 2 === 0) {
        injectStreamerModeUI();
    }
    
    const streamerContainer = document.getElementById('kvd-streamer-container');
    if (streamerContainer) {
        // Visibility Logic: Only visible if Moderator AND Stream is Online (Not Offline)
        // Lógica de Visibilidad: Solo visible si es Moderador Y el stream está en vivo (No Offline)
        // Optimization: Cache offline check if possible, or accept 1s check as necessary cost
        const isOffline = isOfflineVisible();
        
        if (isModerator() && !isOffline) {
            if (streamerContainer.style.display === 'none') {
                streamerContainer.style.display = 'flex';
            }
        } else {
            if (streamerContainer.style.display !== 'none') {
                streamerContainer.style.display = 'none';
                
                // Disable if user loses mod status (safety)
                if (isStreamerModeEnabled && !streamEndDetected) {
                    isStreamerModeEnabled = false;
                    allowTabInactivity();
                    const toggle = document.getElementById('kvd-streamer-toggle');
                    if (toggle) {
                        toggle.classList.remove('kvd-pulse-active');
                        toggle.style.background = '#1a1a1a';
                        toggle.style.borderColor = '#555';
                        toggle.style.boxShadow = 'none';
                        const knob = document.getElementById('kvd-streamer-knob');
                        const label = streamerContainer.querySelector('span');
                        if (knob) { 
                            knob.style.transform = 'translateX(0)'; 
                            knob.style.background = '#fff'; 
                        }
                        if (label) { label.style.color = '#ccc'; }
                    }
                }
            }
        }
    }
    
    checkStreamStatus();
    if (globalCheckCycle % 2 === 0) {
        attemptRejectHost();
    }
    // -------------------------------------------
    
    // Inject thumbnail buttons periodically (Every 5 seconds - Low Priority)
    if (globalCheckCycle % 5 === 0) {
        injectThumbnailButtons();
    }

    // Inject Easter Eggs listener (Every 5 seconds - Low Priority)
    if (globalCheckCycle % 5 === 0) {
        injectEasterEggs();
    }

}, 1000);

// Observer (backup) - Throttled to prevent performance issues
let observerTimeout;
const observer = new MutationObserver(() => {
    if (observerTimeout) return;
    
    observerTimeout = setTimeout(() => {
        if (getVideoId() && !document.querySelector('.kick-vod-download-btn')) {
            injectButton(); 
        }
        // Also check for thumbnails
        injectThumbnailButtons();
        // Easter eggs
        injectEasterEggs();
        observerTimeout = null;
    }, 1500); // Check at most every 1.5 seconds
});

observer.observe(document.body, { childList: true, subtree: true });

// --- Helper: Robust Chat Sending ---
function sendChatMessage(message) {
    const chatInput = document.querySelector('div[data-testid="chat-input"][contenteditable="true"], div[data-input="true"][contenteditable="true"].editor-input');
    if (!chatInput) return;

    chatInput.focus();
    
    // 1. Clear existing content safely
    // Selecting all allows insertText to replace, which is cleaner than innerHTML = ''
    document.execCommand('selectAll', false, null);
    
    // 2. Try execCommand 'insertText' (Native browser behavior)
    // This automatically triggers 'input', 'change', etc., and updates the undo stack.
    // Most modern editors (ProseMirror, Slate, Lexical) handle this correctly.
    const success = document.execCommand('insertText', false, message);
    
    if (!success) {
        // 3. Fallback: Manual DOM construction
        console.log('KVD: execCommand failed, using DOM fallback');
        chatInput.innerHTML = ''; // Force clear
        const p = document.createElement('p');
        p.className = 'editor-paragraph';
        const span = document.createElement('span');
        span.textContent = message; // textContent handles escaping automatically
        p.appendChild(span);
        chatInput.appendChild(p);
        
        // Dispatch input event to wake up the framework
        chatInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    // 4. Trigger Send (Enter Key or Button)
    setTimeout(() => {
        const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label="Enviar mensaje"], button.chat-input-send-button');
        
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        } else {
            // Fallback to Enter key event
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, view: window
            });
            chatInput.dispatchEvent(enterEvent);
        }
    }, 50); // Short delay to allow React to process the input update
}

// --- Easter Eggs (Roadmap #28 & #29) & Custom Commands ---

function parseBooleanSetting(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'exact'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled', 'partial', 'contains'].includes(normalized)) return false;
    return null;
}

function getExactMatchSetting() {
    const directKeys = [
        'kvd_easter_egg_exact_match',
        'kvd_easter_eggs_exact_match',
        'kvd_tricks_exact_match',
        'kvd_chat_exact_match',
        'kvd_exact_match'
    ];

    for (const key of directKeys) {
        const parsed = parseBooleanSetting(localStorage.getItem(key));
        if (parsed !== null) return parsed;
    }

    const objectKeys = [
        'kvd_settings',
        'kvd_chat_settings',
        'kvd_easter_egg_settings',
        'kvd_tricks_settings'
    ];

    const nestedPaths = [
        ['exactMatch'],
        ['easterEggExactMatch'],
        ['tricksExactMatch'],
        ['chatExactMatch'],
        ['easterEggs', 'exactMatch'],
        ['tricks', 'exactMatch']
    ];

    for (const key of objectKeys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
            const obj = JSON.parse(raw);
            for (const path of nestedPaths) {
                let current = obj;
                for (const segment of path) {
                    current = current && current[segment];
                }
                const parsed = parseBooleanSetting(current);
                if (parsed !== null) return parsed;
            }
        } catch (_) {}
    }

    return false;
}

function triggerMatches(cleanText, expectedText, exactMatchEnabled) {
    return exactMatchEnabled ? cleanText === expectedText : cleanText.includes(expectedText);
}

function injectEasterEggs() {
    // Selector based on Roadmap line 30 & 41
    const chatInput = document.querySelector('div[data-testid="chat-input"][contenteditable="true"], div[data-input="true"][contenteditable="true"].editor-input');
    
    if (chatInput && !chatInput.dataset.kvdEggAttached) {
        chatInput.dataset.kvdEggAttached = "true";
        
        chatInput.addEventListener('input', (e) => {
            // STOP INFINITE LOOPS: Ignore events generated by our own code
            if (!e.isTrusted) return;

            // Robust text extraction
            const rawText = e.target.innerText || e.target.textContent || "";
            // Normalize: remove zero-width spaces, turn all whitespace to single space, lowercase
            const cleanText = rawText.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            
            // Helper to clear chat input visually immediately
            const clearChat = () => {
                e.target.textContent = '';
                e.target.innerHTML = '<p class="editor-paragraph"><br></p>';
                // Dispatch input to sync empty state
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
            };

            // --- Custom Commands ---
            if (cleanText === '!redes') {
                clearChat();
                // Default social message - User can customize this later via settings (Todo)
                // Mensaje por defecto
                sendChatMessage("Mis redes: Twitter: @KickStreaming | IG: @KickStreaming (Ejemplo - Configurar en extensión)");
                return;
            }

            // --- Easter Eggs ---
            const exactMatchEnabled = getExactMatchSetting();

            // Roadmap #28: "Imaginate un cubo"
            if (triggerMatches(cleanText, 'imaginate un cubo', exactMatchEnabled)) {
                clearChat();
                triggerCubeEasterEgg();
                return; 
            }

            // "Contexto: No te imaginaste un cubo"
            if (triggerMatches(cleanText, 'contexto: no te imaginaste un cubo', exactMatchEnabled)) {
                clearChat();
                triggerCubeContextEasterEgg();
                return;
            }

            // "Aguante Pavle"
            if (triggerMatches(cleanText, 'aguante pavle', exactMatchEnabled)) {
                clearChat();
                triggerPavleEasterEgg();
                return;
            }

            // "Mondongo"
            if (triggerMatches(cleanText, 'mondongo', exactMatchEnabled)) {
                clearChat();
                triggerMondongoEasterEgg();
                return;
            }

            // "Mambo"
            if (triggerMatches(cleanText, 'mambo', exactMatchEnabled)) {
                clearChat();
                triggerMamboEasterEgg();
                return;
            }

            // "Una maroma!" (Barrel Roll)
            if (triggerMatches(cleanText, 'una maroma!', exactMatchEnabled)) {
                clearChat();
                document.body.classList.add('kvd-barrel-roll');
                setTimeout(() => document.body.classList.remove('kvd-barrel-roll'), 1000);
                return;
            }

            // "me derrito lpm" (Melt)
            if (triggerMatches(cleanText, 'me derrito lpm', exactMatchEnabled)) {
                clearChat();
                document.body.classList.add('kvd-melt-effect');
                // Wait for animation (4s) + a brief "empty" moment (1s)
                setTimeout(() => document.body.classList.remove('kvd-melt-effect'), 5000);
                return;
            }

            // Roadmap #29: "Si le doy un cabezazo al teclado soy admin"
            const enableAdminTricks = [
                "si le doy un cabezazo al teclado soy admin",
                "si le doy un cabezazo al teclado soy admin."
            ];
            
            // Enable Admin Mode (Per Channel)
            if (enableAdminTricks.some(trick => triggerMatches(cleanText, trick, exactMatchEnabled))) {
                const slug = getChannelSlug();
                if (!slug) return;

                const adminChannels = JSON.parse(localStorage.getItem('kvd_admin_channels') || '[]');
                
                if (adminChannels.includes(slug)) {
                     clearChat(); // Already enabled
                     return;
                }

                adminChannels.push(slug);
                localStorage.setItem('kvd_admin_channels', JSON.stringify(adminChannels));
                
                // Cleanup old global flag to avoid confusion
                localStorage.removeItem('kvd_admin_trick_enabled');

                clearChat();
                
                setTimeout(() => {
                    alert(`🔓 Admin Mode Unlocked for ${slug}! / ¡Modo Admin Desbloqueado para ${slug}!`);
                    window.location.reload();
                }, 100);
                return;
            }

            // Disable Admin Mode (Global) - "Ser admin me da ansiedad"
            const disableAdminTricks = [
                "ser admin me da ansiedad",
                "ser admin me da ansiedad."
            ];

            if (disableAdminTricks.some(trick => triggerMatches(cleanText, trick, exactMatchEnabled))) {
                localStorage.removeItem('kvd_admin_channels');
                localStorage.removeItem('kvd_admin_trick_enabled'); // Ensure global is gone too
                
                clearChat();

                setTimeout(() => {
                    alert('🔒 Admin Mode Disabled for ALL channels. / Modo Admin Desactivado para TODOS los canales.');
                    window.location.reload();
                }, 100);
                return;
            }
        });
    }
}

function triggerCubeEasterEgg() {
    // Check if container already exists, remove it to restart cleanly
    let existingContainer = document.getElementById('kvd-cube-container');
    if (existingContainer) {
        existingContainer.remove();
    }
    
    const container = document.createElement('div');
    container.id = 'kvd-cube-container';
    container.className = 'kvd-cube-container active';
    
    container.innerHTML = `
        <div class="kvd-cube">
            <div class="kvd-cube-face front">Kick</div>
            <div class="kvd-cube-face back">VOD</div>
            <div class="kvd-cube-face right">Mondongo</div>
            <div class="kvd-cube-face left">Pavle</div>
            <div class="kvd-cube-face top small-text">Extensión hecha por TheNestorHD</div>
            <div class="kvd-cube-face bottom">Mira mi huevo</div>
        </div>
    `;
    
    document.body.appendChild(container);
    
    // Remove after 10 seconds (animation duration matches CSS)
    setTimeout(() => {
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }
    }, 10000);
}

function triggerCubeContextEasterEgg() {
    // Check if container already exists, remove it
    let existingContainer = document.getElementById('kvd-cube-container');
    if (existingContainer) existingContainer.remove();
    let existingText = document.getElementById('kvd-context-text');
    if (existingText) existingText.remove();

    // Create Cube Container with context-mode class
    const container = document.createElement('div');
    container.id = 'kvd-cube-container';
    container.className = 'kvd-cube-container context-mode';
    
    container.innerHTML = `
        <div class="kvd-cube">
            <div class="kvd-cube-face front">Kick</div>
            <div class="kvd-cube-face back">VOD</div>
            <div class="kvd-cube-face right">Mondongo</div>
            <div class="kvd-cube-face left">Pavle</div>
            <div class="kvd-cube-face top small-text">Extensión hecha por TheNestorHD</div>
            <div class="kvd-cube-face bottom">Mira mi huevo</div>
        </div>
    `;

    // Create Text Element
    const textEl = document.createElement('div');
    textEl.id = 'kvd-context-text';
    textEl.className = 'kvd-context-text';
    textEl.textContent = 'No te imaginaste un cubo';

    document.body.appendChild(container);
    document.body.appendChild(textEl);

    // Remove after 5 seconds
    setTimeout(() => {
        if (container.parentNode) container.parentNode.removeChild(container);
        if (textEl.parentNode) textEl.parentNode.removeChild(textEl);
    }, 5000);
}

function triggerPavleEasterEgg() {
    // Create image element
    const pavleImg = document.createElement('img');
    pavleImg.src = chrome.runtime.getURL('assets/pavle.png');
    pavleImg.alt = 'Pavle Toasty';
    pavleImg.className = 'kvd-pavle-toasty';
    
    // Create audio element
    const toastyAudio = document.createElement('audio');
    toastyAudio.src = chrome.runtime.getURL('assets/toasty.ogg');
    toastyAudio.volume = 0.7;
    
    // Add to DOM
    document.body.appendChild(pavleImg);
    document.body.appendChild(toastyAudio);
    
    // Play sound
    toastyAudio.play().catch(e => console.error('Error playing toasty sound:', e));
    
    // Animate for 1s
    setTimeout(() => {
        // Remove elements
        if (pavleImg.parentNode) pavleImg.parentNode.removeChild(pavleImg);
        if (toastyAudio.parentNode) toastyAudio.parentNode.removeChild(toastyAudio);
    }, 1000);
}

function triggerMondongoEasterEgg() {
    // Create image element
    const gokuImg = document.createElement('img');
    gokuImg.src = chrome.runtime.getURL('assets/gokupelado.png');
    gokuImg.alt = 'Mondongo';
    gokuImg.className = 'kvd-goku-mondongo';
    
    // Create audio element
    const mondongoAudio = document.createElement('audio');
    mondongoAudio.src = chrome.runtime.getURL('assets/mondongo.ogg');
    
    // Add to DOM
    document.body.appendChild(gokuImg);
    document.body.appendChild(mondongoAudio);
    
    // Play sound
    mondongoAudio.play().catch(e => console.error('Error playing mondongo sound:', e));
    
    // Remove after 1s
    setTimeout(() => {
        if (gokuImg.parentNode) gokuImg.parentNode.removeChild(gokuImg);
        if (mondongoAudio.parentNode) mondongoAudio.parentNode.removeChild(mondongoAudio);
    }, 1000);
}

function triggerMamboEasterEgg() {
    // Create image element
    const mamboImg = document.createElement('img');
    mamboImg.src = chrome.runtime.getURL('assets/mambo.png');
    mamboImg.alt = 'Mambo';
    mamboImg.className = 'kvd-mambo-img';
    
    // Create audio element
    const mamboAudio = document.createElement('audio');
    mamboAudio.src = chrome.runtime.getURL('assets/mambo.ogg');
    
    // Add to DOM
    document.body.appendChild(mamboImg);
    document.body.appendChild(mamboAudio);
    
    // Play sound
    mamboAudio.play().catch(e => console.error('Error playing mambo sound:', e));
    
    // Remove after 1s
    setTimeout(() => {
        if (mamboImg.parentNode) mamboImg.parentNode.removeChild(mamboImg);
        if (mamboAudio.parentNode) mamboAudio.parentNode.removeChild(mamboAudio);
    }, 1000);
}
