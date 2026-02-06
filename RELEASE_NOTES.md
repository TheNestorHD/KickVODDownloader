# Release Notes - Kick VOD Downloader v2.0.0

¡Bienvenidos a la versión 2.0.0! Esta actualización trae grandes novedades, especialmente diseñadas para moderadores y creadores de contenido, además de importantes correcciones y optimizaciones.

## ✅ Funciones actuales (resumen amigable)

- **Descarga MP4 en un clic** desde la página del VOD.
- **Selector de calidad** antes de descargar.
- **Modo solo audio (M4A)** para ahorrar espacio.
- **Descarga recortada** eligiendo inicio y fin.
- **Progreso claro** con porcentaje, tamaño y tiempo restante.
- **Progreso global** en el ícono de la extensión y el título de la pestaña.
- **Auto‑silenciado** durante la descarga y restauración automática.
- **Limpieza automática** si cancelas o cambias de video.
- **Botones en miniaturas** para descargar VODs rápidamente.
- **Auto‑DL para moderadores**: detecta fin del stream y descarga solo.
- **Protección contra host/raids** para no perder la descarga.
- **Auto‑retry** ante fallos de red en descargas largas.
- **Notificaciones de escritorio** cuando termina o falla.
- **Prevención de suspensión** de la pestaña mientras descarga o espera.
- **Biblioteca de comandos** en el popup para enviar mensajes rápido.
- **Amplifier** para subir la ganancia de audio (+0 a +48 dB).
- **Animaciones al seguir/dejar de seguir** en la web.

## 🚀 Nuevas Funcionalidades

### Modo Moderador & Descarga Automática
- **Descarga Automática al Finalizar Stream**: Si eres moderador del canal, ahora verás un nuevo interruptor (toggle) en la interfaz. Al activarlo, la extensión detectará automáticamente cuando el stream finalice y comenzará a descargar el último VOD disponible.
- **Detección Inteligente**: El sistema identifica el estado "Desconectado" del canal, espera 2 minutos para que se genere el VOD y gestiona la descarga de forma autónoma.
- **Protección contra Host/Raids**: Se han implementado medidas para evitar que la descarga se confunda si el streamer aloja otro canal al terminar cuando la descarga automática está activa.

### Biblioteca de Comandos para Moderadores
- **Gestión de Comandos y Mensajes**: Nueva herramienta accesible desde el icono de la extensión.
- **Alcance Global y por Canal**: Puedes guardar comandos que uses en todos lados (Global) o mensajes específicos para un canal en particular.
- **Envío Rápido**: Envía tus comandos guardados al chat con un solo clic, sin necesidad de escribirlos repetidamente.

### Mejoras en la Interfaz de Usuario
- **Selector de Calidad de Video**: Ahora puedes elegir la calidad del video antes de descargar (1080p, 720p, 480p, 360p, 160p). Por defecto seleccionará siempre la "Mejor" calidad disponible.
- **Modo Solo Audio (M4A)**: Nueva opción experimental para descargar el audio del VOD. Extrae la pista de audio (AAC) del video de 360p y la guarda como un archivo `.m4a` puro, eliminando la pista de video para ahorrar espacio. Ideal para podcasts o edición.
- **Botones de Descarga en Miniaturas**: Ahora puedes iniciar descargas (Completas o Recortadas) directamente desde las miniaturas de los videos en la sección de VODs, te ahorras un click...
- **Simplificación Visual**: El botón de descarga ahora muestra simplemente "Download" y es ligeramente más grande para facilitar su uso.
- **Apoyo al Desarrollador**: Añadido un botón de "Donate" en el menú de la extensión.

## 🛠 Mejoras y Optimizaciones

- **Prevención de Inactividad**: La extensión ahora evita que la pestaña del navegador entre en modo de suspensión (sleep) mientras hay una descarga activa o el modo de descarga automática está esperando. Esto asegura que las descargas largas no se interrumpan si cambias de pestaña.
- **Limpieza Automática**: Si cancelas una descarga, la página se recargará automáticamente para limpiar la memoria y asegurar que no queden procesos residuales.
- **Optimización de Archivos MP4**: Mejorada la compatibilidad de los archivos generados con reproductores y editores de video.

## 🐛 Correcciones de Errores

- **Visualización de Bitrate en Windows**: Solucionado un problema técnico donde el Explorador de Archivos de Windows mostraba un bitrate incorrecto (ej. 19kbps). Ahora se inyectan los metadatos correctos (átomo `btrt`) para que Windows reporte la calidad real del video.
- **Rendimiento de Auto-DL**: Optimizada la supervisión del stream para reducir drásticamente el uso de CPU y memoria. Se ha eliminado el problema de "congelamiento" del stream tras largas sesiones de uso, asegurando una experiencia fluida incluso después de horas.
- **Auto-DL en Dashboard**: Corregido el comportamiento del interruptor Auto-DL en el panel de control (Dashboard). Ahora redirige correctamente a la página del canal y mantiene el estado activo, evitando recargas fallidas.
- **Protección contra Redirecciones (Host)**: Implementada una estrategia de doble protección (bloqueo de navegación SPA y evento beforeunload) para evitar que la extensión pierda el contexto de descarga cuando el streamer hace host o raid a otro canal.
- **Estabilidad del Chat**: Corregidos errores que causaban duplicación de mensajes o fallos al enviar comandos desde la extensión.

## 🥚 Otros

- **Easter Eggs y Secretos**: Se han añadido varias sorpresas y trucos ocultos en el chat. ¿Podrás descubrirlos todos? (Consulta la documentación externa para más pistas).
