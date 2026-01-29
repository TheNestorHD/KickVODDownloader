# Hoja de Ruta Futura (Roadmap)

Este archivo rastrea las características planificadas, mejoras y problemas conocidos a abordar en futuras versiones de Kick VOD Downloader.

## 🔮 Futuras Versiones (v1.3+)

### 🐛 Correcciones y Mejoras
- [ ] **Visualización de Bitrate en Windows**: Investigar por qué el Explorador de Archivos de Windows ignora el átomo `btrt` y muestra valores incorrectos (ej. 19kbps), a pesar de que el archivo es válido y funciona en editores.
    - *Posible Solución*: Analizar si Windows requiere que el bitrate esté presente en otros átomos MP4 o calculado de manera diferente en la cabecera `moov`.
- [ ] **Soporte de Descarga de Chat**: Añadir capacidad para descargar la repetición del chat junto con el VOD.
- [ ] **Soporte Multi-Navegador**: Verificar y ajustar compatibilidad para Firefox y Safari.

### ✨ Solicitudes de Funcionalidades
- [ ] **Cola de Descargas**: Permitir encolar múltiples VODs para descarga secuencial.
- [ ] **Opciones de Formato**: Permitir a los usuarios elegir entre formatos MP4 (actual) y TS (crudo/raw).
- [ ] **Nombre de Archivo Personalizado**: Opción para personalizar el patrón del nombre de archivo (ej. `Fecha - Streamer - Título`).

---

## 💡 Ideas para Más Adelante
- **Reproductor de Video**: Reproductor simple integrado para previsualizar segmentos descargados.
- **Auto-División**: Opción para dividir VODs muy largos en partes (ej. partes de 1 hora).
