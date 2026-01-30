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

// IndexedDB Helper for robust cleanup
const DB_NAME = 'KickDownloaderDB';
const STORE_NAME = 'handles';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            event.target.result.createObjectStore(STORE_NAME);
        };
    });
}

async function saveHandleToDB(handle) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, 'interrupted_download');
    } catch (e) { console.error('DB Save Error', e); }
}

async function clearHandleFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete('interrupted_download');
    } catch (e) { console.error('DB Clear Error', e); }
}

async function checkAndCleanup() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get('interrupted_download');
        
        request.onsuccess = async () => {
            const handle = request.result;
            if (handle) {
                console.log('Found interrupted download handle');
                // Check permission without prompting
                const perm = await handle.queryPermission({ mode: 'readwrite' });
                if (perm === 'granted') {
                    if (handle.remove) {
                        await handle.remove();
                        console.log('Successfully removed interrupted file');
                    }
                } else {
                    console.log('Permission not granted to remove file, skipping cleanup to avoid prompt');
                }
                // Clear from DB regardless
                clearHandleFromDB();
            }
        };
    } catch (e) { console.error('Cleanup Check Error', e); }
}

// Run cleanup check on load
checkAndCleanup();

// Cleanup on page reload/close
const handleUnload = () => {
    if (currentFileHandle) {
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
        return await response.json();
    } catch (error) {
        console.error('Error fetching video data:', error);
        return null;
    }
}

// Helper to update button state
function updateButton(btn, text, disabled = false, progress = null) {
    btn.disabled = disabled;
    if (progress !== null) {
        btn.innerHTML = `${text} (${progress}%)`;
        btn.style.background = `linear-gradient(to right, #53fc18 ${progress}%, #333 ${progress}%)`;
        btn.style.color = progress > 50 ? '#000' : '#fff';
    } else {
        btn.textContent = text;
        btn.style.background = '';
        btn.style.color = '';
    }
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
function updateOverlay(progress, text = 'Downloading...', etaText = '', currentBytes = 0) {
    let overlay = document.getElementById('kick-vod-overlay');
    
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'kick-vod-overlay';
        overlay.innerHTML = `
            <h2>Downloading VOD / Descargando VOD</h2>
            <p>Please do not close this tab or navigate away.<br>Por favor, no cierres esta pestaña ni navegues a otra página.</p>
            <div class="progress-bar-container">
                <div class="progress-bar-fill"></div>
            </div>
            <div class="progress-text">0%</div>
            <div class="size-text" style="font-size: 0.9em; color: #fff; margin-top: 5px; font-weight: bold;">Size / Tamaño: 0 MB</div>
            <div class="eta-text" style="margin-top: 10px; font-size: 0.9em; color: #ccc;"></div>
            <button class="cancel-btn">Cancel Download / Cancelar</button>
        `;
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
            if (sizeEl) sizeEl.textContent = `Size / Tamaño: ${formatBytes(currentBytes)}`;
        }
        
        const etaEl = overlay.querySelector('.eta-text');
        if (etaEl) etaEl.textContent = etaText;

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
            
            console.log(`Patching mvhd: Timescale=${globalTimescale}, Duration=${durationUnits}`);
            
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
                    // 32-bit: v(1)+f(3)+cr(4)+mod(4)+id(4)+res(4)+dur(4) -> dur at 20
                    // 64-bit: v(1)+f(3)+cr(8)+mod(8)+id(4)+res(4)+dur(8) -> dur at 28
                    // Note: offset relative to payload (after 8 byte header + 4 byte v/f)
                    // Wait, logic check:
                    // 32-bit: 4(v/f) + 4(cr) + 4(mod) + 4(id) + 4(res) = 20. Correct.
                    // 64-bit: 4(v/f) + 8(cr) + 8(mod) + 4(id) + 4(res) = 28. Correct.
                    const durationOffset = tkhd.offset + 8 + (version === 0 ? 20 : 28);
                    
                    // tkhd duration is in mvhd timescale (globalTimescale)
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
                    console.log(`Patching tkhd: Duration=${durationUnits}`);

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
                         // mdhd structure is same as mvhd
                         const timescaleOffset = mdhd.offset + 8 + (version === 0 ? 12 : 20);
                         const durationOffset = timescaleOffset + 4;
                         
                         const localTimescale = view.getUint32(timescaleOffset);
                         const durationUnits = Math.round((durationMs / 1000) * localTimescale);
                         
                         console.log(`Patching mdhd: Timescale=${localTimescale}, Duration=${durationUnits}`);

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

async function downloadSegments(streamUrl, btn, videoDurationMs = 0) {
    try {
        isDownloading = true;
        cancelRequested = false;
        
        // Save original title only if not already saved (prevents recursion issues)
        if (!originalPageTitle) {
            originalPageTitle = document.title;
        }

        // Show blocking overlay
        updateOverlay(0);

        // 1. Fetch playlist
        const response = await fetch(streamUrl);
        const playlistText = await response.text();
        
        // Simple parser for m3u8 to find segments
        const lines = playlistText.split('\n');
        let segments = [];
        let baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

        // Check if it's a master playlist (contains other m3u8 links)
        if (playlistText.includes('EXT-X-STREAM-INF')) {
            // It is a master playlist, find the highest bandwidth
            // For simplicity, just take the first one or look for resolution
            // Ideally we parse properly. Let's find the first .m3u8 link
            const m3u8Match = lines.find(l => l.endsWith('.m3u8') && !l.startsWith('#'));
            if (m3u8Match) {
                let newUrl = m3u8Match.startsWith('http') ? m3u8Match : baseUrl + m3u8Match;
                return downloadSegments(newUrl, btn, videoDurationMs); // Recursion for variant playlist
            }
        }

        // Parse segments and calculate duration if needed
        let calculatedDuration = 0;
        let segmentDurations = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const durationStr = line.substring(8).split(',')[0];
                const d = parseFloat(durationStr);
                if (!isNaN(d)) {
                    calculatedDuration += d;
                    segmentDurations.push(d);
                }
            }

            if (line && !line.startsWith('#')) {
                segments.push(line.startsWith('http') ? line : baseUrl + line);
            }
        }

        // Use calculated duration if API duration is missing or 0
        if ((!videoDurationMs || videoDurationMs === 0) && calculatedDuration > 0) {
            videoDurationMs = calculatedDuration * 1000;
            console.log(`Calculated duration from M3U8: ${videoDurationMs} ms`);
        } else if (videoDurationMs > 0) {
            console.log(`Using API provided duration: ${videoDurationMs} ms`);
        }

        if (segments.length === 0) {
            throw new Error('No segments found');
        }

        // 2. Ask user for file save location
        let handle = null;
        let writable = null;
        let memoryChunks = []; // Fallback for browsers without File System Access API (like Brave)
        
        try {
            if (typeof window.showSaveFilePicker === 'function') {
                handle = await window.showSaveFilePicker({
                    suggestedName: `kick-vod-${getVideoId()}.mp4`,
                    types: [{
                        description: 'MP4 Video',
                        accept: { 'video/mp4': ['.mp4'] },
                    }],
                });
                
                currentFileHandle = handle; // Track for cleanup
                currentDownloadVideoId = getVideoId(); // Track video ID for navigation detection
                saveHandleToDB(handle); // Save to DB for recovery
                
                writable = await handle.createWritable();
            } else {
                console.warn('File System Access API not supported. Using memory fallback.');
                // Update overlay to warn user about memory usage
                const overlayH2 = document.querySelector('#kick-vod-overlay h2');
                if (overlayH2) overlayH2.textContent += ' (Memory Mode / Modo Memoria)';
                
                // Add permanent warning about RAM usage
                const ramWarning = document.createElement('div');
                ramWarning.style.color = '#ff4444';
                ramWarning.style.fontWeight = 'bold';
                ramWarning.style.marginTop = '10px';
                ramWarning.style.padding = '10px';
                ramWarning.style.border = '1px solid #ff4444';
                ramWarning.style.backgroundColor = 'rgba(255, 68, 68, 0.1)';
                ramWarning.innerHTML = '⚠️ WARNING: High RAM Usage Mode<br>Your browser does not support direct disk saving, so the video is stored in memory. Long VODs (>2h) may crash the browser.<br>The page will reload automatically after download to free up RAM.<br><br>⚠️ ADVERTENCIA: Modo de Alto Consumo de RAM<br>Tu navegador no soporta guardado directo en disco, por lo que el video se guarda en memoria. VODs largos (>2h) pueden colgar el navegador.<br>La página se recargará automáticamente al finalizar para liberar RAM.';
                
                const progressBarContainer = document.querySelector('.progress-bar-container');
                if (progressBarContainer) {
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

        transmuxer.on('data', (segment) => {
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

                 if (videoDurationMs > 0) {
                     patchMp4Header(initSeg, videoDurationMs, estimatedBitrate);
                 } else {
                     console.warn('Invalid video duration, skipping header patch');
                 }
                 
                 if (writable) {
                     writable.write(initSeg);
                 } else {
                     memoryChunks.push(initSeg);
                 }
                 initSegmentWritten = true;
            }
            // Write media segment (moof + mdat)
            const mediaSeg = new Uint8Array(segment.data);
            if (writable) {
                writable.write(mediaSeg);
            } else {
                memoryChunks.push(mediaSeg);
            }
        });

        // 4. Download and process segments
        updateButton(btn, 'Downloading...', true, 0);
        
        console.log(`Video Data Duration: ${videoDurationMs} ms`);

        const startTime = Date.now();
        let lastProgress = 0;
        let totalBytes = 0;

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
                transmuxer.push(new Uint8Array(segData));
                transmuxer.flush(); // Flush after each segment to keep memory low and write immediately

                // Update progress
                const progress = Math.round(((i + 1) / segments.length) * 100);
                
                // Only update DOM if percentage changed to avoid thrashing
                if (progress > lastProgress) {
                    lastProgress = progress;
                    
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
                    updateOverlay(progress, 'Downloading VOD / Descargando VOD', etaText, totalBytes);
                }

            } catch (err) {
                console.error(`Error processing segment ${i}:`, err);
                // Continue? or abort? Let's try to continue
            }
        }

        // 100% reached, but still writing/closing
        updateOverlay(100, 'Finalizing file writing... / Finalizando escritura del archivo...', 'Please wait / Por favor espere', totalBytes);

        if (writable) {
            await writable.close();
        } else {
            // Memory fallback: Create blob and trigger download
            console.log('Finalizing memory download...');
            const blob = new Blob(memoryChunks, { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `kick-vod-${getVideoId() || 'video'}.mp4`;
            document.body.appendChild(a);
            a.click();

            // Alert user to reload manually if auto-reload fails or just as a reminder
            alert("When the download finishes, reload the page or close the tab.\n\nCuando la descarga finalice, recarga la página o cierra la pestaña.");
            
            // Cleanup after a delay
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                memoryChunks = []; // Free memory
                
                // Reload page to free RAM as requested
                // Recargar página para liberar RAM como se solicitó
                window.location.reload();
            }, 10000);
        }

        updateButton(btn, 'Download Complete!', false);
        isDownloading = false;
        cancelRequested = false;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        clearHandleFromDB();
        removeOverlay(); // Remove overlay on success
        setTimeout(() => {
             btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12" />
                </svg>
                Download MP4
            `;
            btn.style.background = ''; // reset gradient
        }, 3000);

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
                  btn.innerHTML = `
                     <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                         <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12" />
                     </svg>
                     Download MP4
                 `;
                 btn.style.background = '';
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

// Function to create the download button
function createDownloadButton() {
    if (document.querySelector('.kick-vod-download-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'kick-vod-download-btn';
    btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12" />
        </svg>
        Download MP4
    `;

    btn.addEventListener('click', async () => {
        if (isDownloading) {
            // Overlay should be blocking, but just in case
            alert('Download in progress / Descarga en curso');
            return;
        }

        const videoId = getVideoId();
        if (!videoId) {
            alert('Could not find Video ID');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Preparing...';

        const data = await fetchVideoData(videoId);
        
        if (data && data.source) {
            await downloadSegments(data.source, btn, data.duration);
        } else {
            alert('Could not find video source.');
            btn.disabled = false;
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12" />
                </svg>
                Download MP4
            `;
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
