const extensionApi = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
    // Donate button listener - Always enable this first
    const donateBtn = document.getElementById('donate-btn');
    if (donateBtn) {
        donateBtn.addEventListener('click', () => {
            extensionApi.tabs.create({ url: 'https://ceneka.net/TheNestorHD' });
        });
    }

    // Check if we are on a Kick tab
    const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    
    // Initial check: is it a kick url?
    if (!tab || !tab.url || !tab.url.includes('kick.com')) {
        // Not a kick tab, just show default info (library hidden)
        return;
    }

    // Check Admin status
    extensionApi.tabs.sendMessage(tab.id, { type: 'CHECK_ADMIN' }, (response) => {
        // Handle connection errors (content script not ready, etc)
        if (extensionApi.runtime.lastError) {
            console.log('Error checking admin:', extensionApi.runtime.lastError);
            return;
        }

        if (response && response.isAdmin) {
            // Get channel slug from tab URL
            const urlParts = tab.url.split('/');
            // kick.com/slug or kick.com/video/id -> we need the channel slug
            // If it's a video page, we might need to ask content script for channel slug
            // But usually we are on channel page or VOD page. 
            // Let's ask content script for the slug to be safe.
            extensionApi.tabs.sendMessage(tab.id, { type: 'GET_CHANNEL_SLUG' }, (slugResponse) => {
                const currentSlug = slugResponse ? slugResponse.slug : null;
                initLibraryUI(currentSlug);
            });
        }
    });
});

function initLibraryUI(currentSlug) {
    const container = document.getElementById('library-section');
    if (container) container.style.display = 'block';
    
    // Load library
    loadLibrary(currentSlug);
    
    // Add event listeners
    const addBtn = document.getElementById('add-btn');
    if (addBtn) {
        // Remove old listeners to prevent duplicates (though init is called once per popup open)
        const newBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newBtn, addBtn);
        
        newBtn.addEventListener('click', () => {
            const labelInput = document.getElementById('new-label');
            const msgInput = document.getElementById('new-msg');
            const scopeInput = document.querySelector('input[name="scope"]:checked');
            
            const label = labelInput.value.trim();
            const msg = msgInput.value.trim();
            const scope = scopeInput ? scopeInput.value : 'global';
            
            if (label && msg) {
                // If channel scope selected but no slug (unlikely), fallback to global
                const targetSlug = (scope === 'channel' && currentSlug) ? currentSlug : null;
                
                addToLibrary(label, msg, targetSlug, currentSlug);
                labelInput.value = '';
                msgInput.value = '';
            }
        });
    }
}

function loadLibrary(currentSlug) {
    extensionApi.storage.local.get(['kvd_chat_library'], (result) => {
        const library = result.kvd_chat_library || [];
        renderLibrary(library, currentSlug);
    });
}

function addToLibrary(label, message, channelSlug, currentSlug) {
    extensionApi.storage.local.get(['kvd_chat_library'], (result) => {
        const library = result.kvd_chat_library || [];
        library.push({ 
            id: Date.now(), 
            label, 
            message,
            channel: channelSlug // null for global, string for specific channel
        });
        extensionApi.storage.local.set({ kvd_chat_library: library }, () => {
            renderLibrary(library, currentSlug);
        });
    });
}

function renderLibrary(library, currentSlug) {
    const list = document.getElementById('library-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    // Filter items: Global + Current Channel
    const visibleItems = library.filter(item => {
        return !item.channel || (currentSlug && item.channel.toLowerCase() === currentSlug.toLowerCase());
    });
    
    if (visibleItems.length === 0) {
        list.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:10px;">No commands yet. Add one below!</div>';
        return;
    }
    
    visibleItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'lib-item';
        
        const btn = document.createElement('button');
        btn.className = 'lib-btn';
        // Add indicator for channel-specific items
        const scopeIcon = item.channel ? '🔒 ' : '🌐 ';
        btn.textContent = scopeIcon + item.label;
        btn.title = `${item.message} (${item.channel ? 'Channel only' : 'Global'})`;
        btn.onclick = () => sendToChat(item.message);
        
        const del = document.createElement('button');
        del.className = 'del-btn';
        del.innerHTML = '&times;';
        del.onclick = (e) => {
            e.stopPropagation();
            removeFromLibrary(item.id, currentSlug);
        };
        
        div.appendChild(btn);
        div.appendChild(del);
        list.appendChild(div);
    });
}

function removeFromLibrary(id, currentSlug) {
    extensionApi.storage.local.get(['kvd_chat_library'], (result) => {
        let library = result.kvd_chat_library || [];
        library = library.filter(item => item.id !== id);
        extensionApi.storage.local.set({ kvd_chat_library: library }, () => {
            renderLibrary(library, currentSlug);
        });
    });
}

function sendToChat(message) {
    extensionApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            extensionApi.tabs.sendMessage(tabs[0].id, { type: 'SEND_CHAT', message });
        }
    });
}
