// Global variables for cleanup
let currentFileHandle = null;
let currentWritable = null;

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

async function downloadSegments(streamUrl, btn) {
    try {
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
                return downloadSegments(newUrl, btn); // Recursion for variant playlist
            }
        }

        // Parse segments
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#')) {
                segments.push(line.startsWith('http') ? line : baseUrl + line);
            }
        }

        if (segments.length === 0) {
            throw new Error('No segments found');
        }

        // 2. Ask user for file save location
        const handle = await window.showSaveFilePicker({
            suggestedName: `kick-vod-${getVideoId()}.mp4`,
            types: [{
                description: 'MP4 Video',
                accept: { 'video/mp4': ['.mp4'] },
            }],
        });
        
        currentFileHandle = handle; // Track for cleanup
        saveHandleToDB(handle); // Save to DB for recovery
        
        const writable = await handle.createWritable();
        
        // 3. Initialize Transmuxer
        const transmuxer = new muxjs.mp4.Transmuxer({keepOriginalTimestamps: true});
        let initSegmentWritten = false;

        transmuxer.on('data', (segment) => {
            // Write init segment (ftyp + moov) only once
            if (!initSegmentWritten) {
                 writable.write(new Uint8Array(segment.initSegment));
                 initSegmentWritten = true;
            }
            // Write media segment (moof + mdat)
            writable.write(new Uint8Array(segment.data));
        });

        // 4. Download and process segments
        updateButton(btn, 'Downloading...', true, 0);
        
        for (let i = 0; i < segments.length; i++) {
            try {
                const segRes = await fetch(segments[i]);
                if (!segRes.ok) throw new Error(`Failed to fetch segment ${i}`);
                const segData = await segRes.arrayBuffer();
                
                // Push to transmuxer
                transmuxer.push(new Uint8Array(segData));
                transmuxer.flush(); // Flush after each segment to keep memory low and write immediately

                // Update progress
                const progress = Math.round(((i + 1) / segments.length) * 100);
                updateButton(btn, 'Downloading...', true, progress);

            } catch (err) {
                console.error(`Error processing segment ${i}:`, err);
                // Continue? or abort? Let's try to continue
            }
        }

        await writable.close();
        updateButton(btn, 'Download Complete!', false);
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
        currentWritable = null;
        currentFileHandle = null;

        console.error('Download failed:', error);
        alert('Download failed: ' + error.message);
        updateButton(btn, 'Error', false);
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
        const videoId = getVideoId();
        if (!videoId) {
            alert('Could not find Video ID');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Preparing...';

        const data = await fetchVideoData(videoId);
        
        if (data && data.source) {
            await downloadSegments(data.source, btn);
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
    if (getVideoId() && !document.querySelector('.kick-vod-download-btn')) {
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
