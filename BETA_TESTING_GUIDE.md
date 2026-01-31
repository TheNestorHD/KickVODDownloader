# 🧪 Guía para Beta Testers: Kick VOD Downloader v1.2

¡Gracias por ayudar a probar **Kick VOD Downloader**! Aquí te explicamos cómo funciona la magia "bajo el capó" y qué cosas específicas necesitamos que pruebes.

## 🚀 ¿Cómo funciona realmente?

A diferencia de las páginas web de descargas que procesan el video en un servidor remoto, esta extensión convierte a **tu navegador** en el servidor de procesamiento.

1.  **Interceptación**: La extensión detecta el archivo "maestro" (`.m3u8`) del video cuando entras a la página de Kick.
2.  **Descarga Fragmentada**: Descarga el video en miles de pequeños pedacitos (`.ts` chunks) directamente desde los servidores de Kick a la memoria RAM de tu navegador.
3.  **Transmuxing en Vivo**: Usa una librería llamada `mux.js` para convertir esos pedacitos de formato Transporte (TS) a formato MP4 estándar en tiempo real.
4.  **Escritura Directa**: A medida que convierte los pedacitos, los va escribiendo directamente en tu disco duro usando la *File System Access API*. **No espera al final para guardar**, lo hace sobre la marcha para no saturar tu memoria RAM.

**Por eso es tan rápida:** No hay intermediarios. Es una conexión directa: Servidor de Kick ➔ Tu Navegador ➔ Tu Disco Duro.

---

## 🎯 Misiones de Prueba (Testing Quests)

### 1. La Prueba de Fuego (Integridad)
*   **Misión:** Descarga un VOD corto (5-10 min) y uno largo (+1 hora).
*   **Qué buscar:** Intenta importar el archivo resultante en **DaVinci Resolve**, **Premiere** o **CapCut**.
*   **Éxito:** Si el editor lo acepta, muestra la duración correcta y puedes arrastrarlo a la línea de tiempo sin errores, ¡es un éxito!

### 2. La Prueba de UX (Experiencia de Usuario)
*   **Misión:** Inicia una descarga y **cambia de pestaña** para navegar en otra cosa (Youtube, Twitter/X).
*   **Qué buscar:**
    *   Fíjate en el **icono de la extensión** arriba a la derecha: ¿Muestra el porcentaje?
    *   Fíjate en el **título de la pestaña** de Kick: ¿Se actualiza el progreso?
    *   Vuelve a la pestaña de Kick: ¿El audio sigue silenciado correctamente?

### 3. La Prueba de Estrés (Cancelación)
*   **Misión:** Inicia una descarga, espera al 10-15% y dale al botón **Cancelar**. Sin recargar la página, intenta descargar el mismo video (u otro) de nuevo.
*   **Qué buscar:** No debería salir el error "Download in progress". Debería empezar de cero limpiamente.

---

## 🐛 Bugs Conocidos (No reportar)
*   **Bitrate en Windows:** Si haces clic derecho en el archivo -> Propiedades, es posible que Windows diga que el video tiene "19kbps" de bitrate o similar. **Esto es un error visual de Windows**. El archivo real tiene la calidad original (Source) de Kick. Ignoren este número, lo importante es que se vea bien en el reproductor.

---

¡Gracias por romper (o intentar romper) la extensión! 🛠️
