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
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put(handle, 'interrupted_download');
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Save Handle Error', e); }
}

async function clearHandleFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete('interrupted_download');
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Clear Handle Error', e); }
}

async function saveChunkToDB(chunk) {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).add(chunk);
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { 
        console.error('DB Save Chunk Error', e);
        throw e; // Critical error
    }
}

async function clearChunksFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).clear();
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Clear Chunks Error', e); }
}

async function getAllChunksFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readonly');
        const store = tx.objectStore(CHUNK_STORE);
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
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

// Run cleanup check on load
checkAndCleanup();

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

// Listen for messages from background script (Navigation detection)
// Removed navigation detection logic.
// We now allow navigation while downloading.

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
        const response = await fetch(`https://kick.com/api/v1/video/${videoId}`);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        console.log('API Video Data:', data); // Log full API response for debugging
        return data;
    } catch (error) {
        console.error('Error fetching video data:', error);
        return null;
    }
}

// Helper to update button state
function updateButton(btn, text, disabled = false, progress = null) {
    btn.disabled = disabled;
    if (progress !== null) {
        btn.textContent = `${text} (${progress}%)`;
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
    btn.appendChild(createDownloadSvg());
    btn.appendChild(document.createTextNode('\n        Download MP4\n    '));
    btn.style.background = '';
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
        p.textContent = 'Please do not close this tab or navigate away.\nPor favor, no cierres esta pestaña ni navegues a otra página.';
        p.style.whiteSpace = 'pre-wrap';
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
        cancelBtn.className = 'cancel-btn';
        cancelBtn.textContent = 'Cancel Download / Cancelar';
        overlay.appendChild(cancelBtn);
        document.body.appendChild(overlay);
        
        // Prevent scroll
        document.body.style.overflow = 'hidden';
        mutePageAudio();

        // Bind cancel button
        overlay.querySelector('.cancel-btn').addEventListener('click', async () => {
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

        // 1. Find moov
        const moov = findBox(0, view.byteLength, 'moov');
        if (!moov) return;

        // 2. Patch mvhd (Movie Header)
        const mvhd = findBox(moov.offset + 8, moov.offset + moov.size, 'mvhd');
        let globalTimescale = 90000; // Default fallback
        
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            // 32-bit: v(1)+f(3)+cr(4)+mod(4)+scale(4)+dur(4) -> scale at 12, dur at 16
            // 64-bit: v(1)+f(3)+cr(8)+mod(8)+scale(4)+dur(8) -> scale at 20, dur at 24
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            
            globalTimescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
            
            // console.log(`[Patch] mvhd: Version=${version}, Timescale=${globalTimescale}, Duration=${durationUnits}`);
            
            if (version === 0) {
                view.setUint32(durationOffset, durationUnits);
            } else {
                 // High 32 bits
                 view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                 // Low 32 bits
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
                    
                    // tkhd duration is in mvhd timescale (globalTimescale)
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
                    // console.log(`[Patch] tkhd: Duration=${durationUnits}`);

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
                         
                         // console.log(`[Patch] mdhd: Timescale=${localTimescale}, Duration=${durationUnits}`);

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
                                // stsd has 8 bytes header + 4 bytes count. Entries start at offset+12
                                const avc1 = findBox(stsd.offset + 12, stsd.offset + stsd.size, 'avc1');
                                if (avc1) {
                                    // avc1 header (8) + reserved(6) + dataRefIdx(2) + pre_defined(2) + reserved(2) + pre_defined(12) 
                                    // + width(2) + height(2) + horiz_res(4) + vert_res(4) + reserved(4) + frame_count(2) 
                                    // + compressorname(32) + depth(2) + pre_defined(2) = 78 bytes of VisualSampleEntry fields
                                    // Children start after that.
                                    const childrenStart = avc1.offset + 8 + 78;
                                    const btrt = findBox(childrenStart, avc1.offset + avc1.size, 'btrt');
                                    if (btrt) {
                                        // btrt: size(4) + type(4) + bufferSizeDB(4) + maxBitrate(4) + avgBitrate(4)
                                        const maxBitrateOffset = btrt.offset + 12;
                                        const avgBitrateOffset = btrt.offset + 16;
                                        
                                        // Use calculated bitrate if available, otherwise fallback to reasonable defaults
                                        const finalAvgBitrate = avgBitrate > 0 ? avgBitrate : 8000000;
                                        // Max bitrate = Avg + 50% buffer, or at least 12Mbps
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

    } catch (e) {
        console.error('Error patching MP4 headers:', e);
    }
}

async function downloadSegments(streamUrl, btn, videoDurationMs, startSeconds = 0, endSeconds = -1, preOpenedHandle = null) {
    try {
        isDownloading = true;
        cancelRequested = false;
        
        // Save original title only if not already saved (prevents recursion issues)
        if (!originalPageTitle) {
            originalPageTitle = document.title;
        }

        // --- FILE PICKER MOVED HERE TO SATISFY USER GESTURE REQUIREMENT ---
        // We must ask for the file handle immediately, before any network requests (fetch)
        let handle = preOpenedHandle;
        
        // Only ask if we don't have a handle AND we support the API AND it's not a recursive call with handle
        if (!handle && typeof window.showSaveFilePicker === 'function') {
             try {
                 // Suggest filename
                 const suggestedName = `kick-vod-${getVideoId() || 'video'}.mp4`;
                 
                 handle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: 'MP4 Video',
                        accept: { 'video/mp4': ['.mp4'] },
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

                return downloadSegments(bestVariant.url, btn, videoDurationMs, startSeconds, endSeconds, handle);
            }
            
            // Fallback to simple search if parsing failed
            const m3u8Match = lines.find(l => l.endsWith('.m3u8') && !l.startsWith('#'));
            if (m3u8Match) {
                let newUrl = m3u8Match.startsWith('http') ? m3u8Match : baseUrl + m3u8Match;
                console.log(`Fallback: Found .m3u8 link, redirecting to: ${newUrl}`);
                return downloadSegments(newUrl, btn, videoDurationMs, startSeconds, endSeconds, handle);
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
                     segments.push(line.startsWith('http') ? line : baseUrl + line);
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
            } else {
                console.warn('File System Access API not supported or Handle missing. Using IDB fallback.');
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
                    ramWarning.textContent = 'ℹ️ INFO: Compatibility Mode / Modo Compatibilidad\nYour browser does not support direct disk saving. The video will be stored in temporary storage and assembled at the end.\nPlease ensure you have enough free disk space (at least double the video size).\n\nℹ️ INFO: Modo Compatibilidad\nTu navegador no soporta guardado directo. El video se guardará en almacenamiento temporal y se ensamblará al final.\nAsegúrate de tener espacio libre (al menos el doble del tamaño del video).';
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
        const transmuxer = new muxjs.mp4.Transmuxer({keepOriginalTimestamps: false});
        let initSegmentWritten = false;
        // Capture first segment duration for bitrate calculation
        const firstSegmentDuration = segmentDurations.length > 0 ? segmentDurations[0] : 0;
        
        // Track IDB write promises to prevent race condition at the end
        const writePromises = [];
        // Track File System writes sequentially to prevent race conditions in Edge/Chrome
        let fileWriteChain = Promise.resolve();

        transmuxer.on('data', async (segment) => {
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
                     patchMp4Header(initSeg, targetDurationMs, estimatedBitrate);
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

        for (let i = 0; i < segments.length; i++) {
            if (cancelRequested) {
                throw new Error('Download cancelled by user / Descarga cancelada por el usuario');
            }

            try {
                const segRes = await fetch(segments[i]);
                if (!segRes.ok) throw new Error(`Failed to fetch segment ${i}`);
                const segData = await segRes.arrayBuffer();
                
                // Track total bytes
                totalBytes += segData.byteLength;
                
                // Push to transmuxer
                // Fix for Firefox "Permission denied to access property constructor"
                // Clone data into a new Uint8Array created explicitly in this scope
                const sourceBytes = new Uint8Array(segData);
                const cleanBytes = new Uint8Array(sourceBytes.length);
                cleanBytes.set(sourceBytes);

                transmuxer.push(cleanBytes);
                transmuxer.flush(); // Flush after each segment to keep memory low and write immediately

                // Update progress
                const progress = Math.round(((i + 1) / segments.length) * 100);
                
                // Calculate instantaneous speed and ETA every ~1s or when progress changes
                const now = Date.now();
                const timeDiff = (now - lastSpeedTime) / 1000; // seconds
                
                // Calculate speed every second regardless of progress change
                if (timeDiff >= 1) { 
                     const bytesDiff = totalBytes - lastSpeedBytes;
                     currentSpeed = bytesDiff / timeDiff; // bytes per second
                     lastSpeedTime = now;
                     lastSpeedBytes = totalBytes;
                }

                // Update DOM if percentage changed OR it's been >1s since last update (to show speed/size changes)
                if (progress > lastProgress || (now - lastUiUpdate > 1000)) {
                    lastProgress = Math.max(lastProgress, progress); // Keep max progress
                    lastUiUpdate = now;
                    
                    // Calculate ETA
                    const elapsedTime = (Date.now() - startTime) / 1000; // seconds
                    let etaText = 'Calculating time...';
                    
                    if (elapsedTime > 2 && i > 0) { // Wait a bit for stable calculation
                        const rate = (i + 1) / elapsedTime; // segments per second
                        const remainingSegments = segments.length - (i + 1);
                        const etaSeconds = remainingSegments / rate;
                        etaText = `Estimated time remaining: ${formatTime(etaSeconds)}`;
                    }

                    updateButton(btn, 'Downloading...', true, progress);
                    updateOverlay(progress, 'Downloading VOD / Descargando VOD', etaText, totalBytes, currentSpeed);
                }

            } catch (err) {
                console.error(`Error processing segment ${i}:`, err);
                // Continue? or abort? Let's try to continue
            }
        }

        // 100% reached, but still writing/closing
        updateOverlay(100, 'Finalizing file writing... / Finalizando escritura del archivo...', 'Please wait / Por favor espere', totalBytes);

        if (writable) {
            // Wait for all pending writes to complete
            console.log('Waiting for pending file writes to complete...');
            await fileWriteChain;
            
            await writable.close();
        } else {
            // Memory fallback: Create blob and trigger download
            console.log('Finalizing memory download... reading from IDB');
            updateOverlay(100, 'Assembling video file... / Ensamblando archivo de video...', 'This may take a minute... / Esto puede tardar un minuto...', totalBytes);
            
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
            
            const blob = new Blob(chunks, { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `kick-vod-${getVideoId() || 'video'}.mp4`;
            document.body.appendChild(a);
            a.click();

            // Removed manual alert and reload as requested
            // alert("When the download finishes, reload the page or close the tab.\n\nCuando la descarga finalice, recarga la página o cierra la pestaña.");
            
            // Cleanup after a delay
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                clearChunksFromDB(); // Free disk space
                
                // No auto-reload
                // window.location.reload();
            }, 30000); // Increased timeout to give time for large file assembly/download start
        }

        updateButton(btn, 'Download Complete!', false);
        isDownloading = false;
        cancelRequested = false;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        currentFileHandle = null; // Prevent deletion on reload
        currentWritable = null;
        clearHandleFromDB();
        removeOverlay(); // Remove overlay on success
        setTimeout(async () => {
             setButtonToDownload(btn);
             // Force reload to clear memory/state and prevent bugs
             try {
                 await clearChunksFromDB(); 
             } catch (e) { console.error(e); }
             window.location.reload();
        }, 4000);

    } catch (error) {
        // Cleanup on error
        if (currentWritable) await currentWritable.abort().catch(() => {});
        if (currentFileHandle && currentFileHandle.remove) {
            await currentFileHandle.remove().catch(() => {});
        }
        currentFileHandle = null;
        currentWritable = null;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        clearHandleFromDB();

        console.error('Download failed:', error);
        
        // Only alert if it's not a user cancellation
        if (error.name === 'AbortError' || error.message.includes('user aborted') || error.message.includes('cancelled by user')) {
             updateButton(btn, 'Cancelled', false);
             setTimeout(() => {
                  setButtonToDownload(btn);
             }, 2000);
        } else {
            alert('Download failed: ' + error.message);
            updateButton(btn, 'Error', false);
        }
        isDownloading = false;
        cancelRequested = false;
        
        removeOverlay();
    }
}

// Function to create and show the download options modal
function createDownloadOptionsModal(videoId, durationMs, btn) {
    // Remove existing modal if any
    const existingModal = document.querySelector('.kvd-modal-overlay');
    if (existingModal) existingModal.remove();

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
        btn.textContent = 'Download MP4';
    };

    closeModalBtn.onclick = close;
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };

    // Download All
    downloadAllBtn.onclick = async () => {
        modal.remove();
        const videoData = await fetchVideoData(videoId); // Fetch again to get fresh source
        if (videoData && videoData.source) {
             await downloadSegments(videoData.source, btn, videoData.duration, 0, -1);
        } else {
             alert('Could not fetch video source');
             btn.disabled = false;
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
        
        const videoData = await fetchVideoData(videoId);
        if (videoData && videoData.source) {
             // Pass start/end in seconds
             await downloadSegments(videoData.source, btn, videoData.duration, startSeconds, endSeconds);
        } else {
             alert('Could not fetch video source');
             btn.disabled = false;
        }
    };
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

// Persistencia: Comprobar cada segundo si el botón sigue ahí
// Esto es necesario porque Kick es una SPA agresiva que regenera el DOM
setInterval(() => {
    const currentId = getVideoId();

    // Navigation detection
    if (currentDownloadVideoId && currentId && currentId !== currentDownloadVideoId) {
        console.log('Navigation detected! Cancelling download...');
        cancelRequested = true;
        handleUnload();
    }

    if (currentId && !document.querySelector('.kick-vod-download-btn')) {
        injectButton();
    }
}, 1000);

// Observer (backup)
const observer = new MutationObserver(() => {
    if (getVideoId() && !document.querySelector('.kick-vod-download-btn')) {
        injectButton(); // Llamada directa sin espera
    }
});

observer.observe(document.body, { childList: true, subtree: true });
