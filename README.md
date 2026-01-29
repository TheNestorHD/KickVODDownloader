# Kick VOD Downloader

**Kick VOD Downloader** is a browser extension (Chrome/Edge) that allows you to download VODs (Video on Demand) from Kick.com directly as **MP4 files** with a single click. No command-line tools, no external websites, and no complex setup required.

![Icon](icons/icon128.png)

## 🇬🇧 English

### 🚀 Key Features

*   **One-Click Download**: Adds a native-looking "Download MP4" button directly to the Kick video player interface.
*   **Direct MP4 Conversion**: Automatically converts Kick's HLS streams (.m3u8) into standard MP4 files on the fly, right within your browser.
*   **Memory Efficient**: Uses the File System Access API to write directly to your disk, ensuring even long streams download smoothly without crashing your browser.
*   **Persistent Progress**: If you resize the window or the DOM updates, the download state is saved so you never lose track.
*   **Smart Cleanup**: Automatically cleans up temporary files if a download is interrupted or the page is closed.

### 📥 Installation (Manual / Developer Mode)

Since this extension is not published in the Web Store, you need to install it manually:

1.  **Download** this repository:
    *   Click on the green **Code** button -> **Download ZIP**.
    *   Unzip the file into a folder.
2.  Open your browser's extension manager:
    *   **Chrome**: Go to `chrome://extensions/`
    *   **Edge**: Go to `edge://extensions/`
3.  Enable **Developer mode** (toggle switch usually located at the top right corner).
4.  Click the **Load unpacked** (Chrome) or **Load extension** (Edge) button.
5.  Select the **folder** where you extracted the files (the one containing `manifest.json`).
6.  **Done!** Navigate to any Kick.com VOD and you will see the "Download MP4" button.

### 📖 How to Use

1.  Go to any VOD on **Kick.com**.
2.  Look for the green **"Download MP4"** button (usually next to the "Share" button or floating at the bottom right).
3.  Click it and choose where to save your file.
4.  Wait for the download to finish. The button will show the progress percentage.

---

## 🇪🇸 Español

### � Características Principales

*   **Descarga en un Clic**: Añade un botón "Download MP4" directamente en la interfaz del reproductor de Kick.
*   **Conversión Directa a MP4**: Convierte automáticamente los streams HLS (.m3u8) de Kick en archivos MP4 estándar al vuelo, dentro de tu navegador.
*   **Eficiencia de Memoria**: Utiliza la API de Acceso al Sistema de Archivos para escribir directamente en tu disco, permitiendo descargar streams largos sin colapsar el navegador.
*   **Progreso Persistente**: Si redimensionas la ventana o la página se actualiza, el estado de la descarga se mantiene.
*   **Limpieza Inteligente**: Elimina automáticamente archivos temporales o corruptos si la descarga se interrumpe o cierras la página.

### 📥 Instalación (Manual / Modo Desarrollador)

Como esta extensión no está publicada en la tienda, necesitas instalarla manualmente:

1.  **Descarga** este repositorio:
    *   Haz clic en el botón verde **Code** -> **Download ZIP**.
    *   Descomprime el archivo en una carpeta.
2.  Abre el gestor de extensiones de tu navegador:
    *   **Chrome**: Ve a `chrome://extensions/`
    *   **Edge**: Ve a `edge://extensions/`
3.  Activa el **Modo de desarrollador** (interruptor generalmente ubicado arriba a la derecha).
4.  Haz clic en el botón **Cargar descomprimida** (Chrome) o **Cargar extensión** (Edge).
5.  Selecciona la **carpeta** donde extrajiste los archivos (la carpeta que contiene el archivo `manifest.json`).
6.  **¡Listo!** Ve a cualquier VOD de Kick.com y verás el botón de "Download MP4".

### 📖 Cómo Usar

1.  Entra a cualquier VOD en **Kick.com**.
2.  Busca el botón verde **"Download MP4"** (normalmente al lado del botón "Share" o flotando abajo a la derecha).
3.  Haz clic y elige dónde guardar tu archivo.
4.  Espera a que termine la descarga. El botón mostrará el porcentaje de progreso.

---

## ⚠️ Disclaimer / Aviso

*   This extension is for **personal archiving purposes and VODs recover**. Please respect the copyright and intellectual property rights of streamers.
*   *Esta extensión es para fines de **archivo personal y recuperación de VODs**. Por favor, respeta los derechos de autor y la propiedad intelectual de los streamers.*
