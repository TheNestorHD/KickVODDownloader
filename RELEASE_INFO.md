# Release Info / Información de Lanzamiento

## Version 1.3
**Release Date / Fecha de Lanzamiento:** 2026-01-29

### 🇬🇧 English
**Changelog:**
*   **Universal Chromium Support:** Added full support for **Brave** and other Chromium browsers.
*   **Memory Fallback Mode:** Automatically switches to RAM mode when disk writing is restricted, with smart RAM management warnings.
*   **Real-Time Stats:** Download overlay now shows **File Size** (MB/GB) and **ETA** (Estimated Time Remaining).
*   **Enhanced UX:** Improved progress overlay with detailed status information.

**Description:**
This update makes Kick VOD Downloader truly universal. It now works seamlessly on Brave and other strict Chromium browsers by intelligently switching storage modes. We've also upgraded the download experience with real-time file size and time remaining indicators.

---

### 🇪🇸 Español
**Lista de Cambios:**
*   **Soporte Universal Chromium:** Añadido soporte completo para **Brave** y otros navegadores Chromium.
*   **Modo Memoria (Fallback):** Cambia automáticamente a modo RAM cuando la escritura en disco está restringida, con advertencias de gestión de RAM.
*   **Estadísticas en Tiempo Real:** El overlay de descarga ahora muestra **Tamaño del Archivo** (MB/GB) y **ETA** (Tiempo Restante Estimado).
*   **UX Mejorada:** Overlay de progreso mejorado con información de estado detallada.

**Descripción:**
Esta actualización hace que Kick VOD Downloader sea verdaderamente universal. Ahora funciona perfectamente en Brave y otros navegadores estrictos cambiando inteligentemente el modo de almacenamiento. También hemos mejorado la experiencia de descarga con indicadores de tamaño de archivo y tiempo restante en tiempo real.

---

## Version 1.2
**Release Date / Fecha de Lanzamiento:** 2026-01-29

### 🇬🇧 English
**Changelog:**
*   **Fixed Video Metadata:** Solved an issue where downloaded VODs would show incorrect durations.
*   **Editor Compatibility:** Generated MP4 files are now fully compatible with video editors like DaVinci Resolve.
*   **Global Progress:** Download progress is now visible on the extension icon and tab title.
*   **UX Improvements:** Added auto-mute during download, real-time ETA calculation, and a clear "Finalizing" status message.
*   **Known Issue:** Windows File Properties might display incorrect bitrate, but the file is valid.

**Description:**
This update brings professional-grade reliability. We've fixed metadata issues to ensure VODs work perfectly in editors like DaVinci Resolve. We also added global progress tracking, auto-mute, and ETA features for a smoother experience.

---

### 🇪🇸 Español
**Lista de Cambios:**
*   **Metadatos Corregidos:** Se solucionó el problema de las duraciones incorrectas en los videos.
*   **Compatibilidad con Editores:** Los archivos MP4 son ahora totalmente compatibles con editores como DaVinci Resolve.
*   **Progreso Global:** El progreso de la descarga es visible en el icono de la extensión y el título de la pestaña.
*   **Mejoras de UX:** Se añadió auto-silenciado durante la descarga, cálculo de tiempo restante (ETA) y mensaje de "Finalizando".
*   **Problema Conocido:** Windows puede mostrar un bitrate incorrecto en propiedades, pero el archivo es válido.

**Descripción:**
Esta actualización trae confiabilidad profesional. Arreglamos los metadatos para que los VODs funcionen directo en editores como DaVinci Resolve. También sumamos seguimiento de progreso global, auto-silenciado y cálculo de tiempo restante.

---

## Version 1.0.1
**Release Date / Fecha de Lanzamiento:** 2026-01-28

### 🇬🇧 English
**Changelog:**
*   **New Feature:** Added automatic download cancellation when navigating between videos (SPA navigation).
*   **Improvement:** Enhanced file cleanup logic. If you leave the page or switch videos, the partial .mp4 file is immediately deleted to prevent disk clutter.
*   **Bug Fix:** Fixed an issue where downloads might persist in the background or leave 0KB files when changing URLs.

**Description:**
This update focuses on user experience and storage hygiene. It ensures that downloads are strictly tied to the current video context. If you browse away, the extension smartly cleans up after itself.

---

### 🇪🇸 Español
**Lista de Cambios:**
*   **Nueva Función:** Añadida cancelación automática de la descarga al navegar entre videos (navegación SPA).
*   **Mejora:** Lógica de limpieza de archivos mejorada. Si sales de la página o cambias de video, el archivo .mp4 parcial se elimina inmediatamente para no ocupar espacio.
*   **Corrección:** Solucionado un problema donde las descargas podían persistir en segundo plano o dejar archivos de 0KB al cambiar de URL.

**Descripción:**
Esta actualización se centra en la experiencia de usuario y la higiene del almacenamiento. Asegura que las descargas estén estrictamente ligadas al contexto del video actual. Si navegas a otro lado, la extensión limpia todo automáticamente.
