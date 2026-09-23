# EILOR — Suite ESP32 para espectro Wi‑Fi, radar BLE y portal cautivo

EILOR es un proyecto educativo de Sistemas de Información y Ciberseguridad que integra un ESP32 con pantalla OLED, un servidor Node.js y un dashboard web en tiempo real.

## Componentes

- `firmware/`: sketch para ESP32, pantalla OLED, análisis Wi‑Fi/BLE, SoftAP y portal cautivo.
- `server.js` y `lib/`: API HTTP, WebSocket, autenticación, telemetría y persistencia local.
- `public/`: dashboard web y vista previa del portal.
- `tesis-latex/`: informe académico y manual técnico del proyecto.
- `data/`: datos locales generados en ejecución; no se versionan.

## Requisitos

- Node.js 18 o superior.
- Arduino IDE o PlatformIO con soporte para ESP32.
- Librerías Arduino: `WebSockets` (Markus Sattler), `Adafruit SSD1306`, `Adafruit GFX` y `ezButton`.

## Servidor web

```bash
npm install
EILOR_PASSWORD="cambia-esta-clave" EILOR_DEVICE_TOKEN="token-del-dispositivo" npm start
```

El dashboard queda disponible en `http://localhost:3002`. Por defecto el servidor escucha en `127.0.0.1:3002`; puede cambiarse con `HOST` y `PORT`.

Variables principales:

| Variable | Uso |
|---|---|
| `EILOR_PASSWORD` | Contraseña del dashboard. Obligatoria en producción. |
| `EILOR_DEVICE_TOKEN` | Token opcional para proteger la ingesta del ESP32. |
| `HOST` | Interfaz de escucha; por defecto `127.0.0.1`. |
| `PORT` | Puerto HTTP/WebSocket; por defecto `3002`. |

## Firmware ESP32

1. Abra `firmware/eilor_esp32.ino` en Arduino IDE.
2. Instale las librerías indicadas arriba.
3. Configure `WIFI_SSID`, `WIFI_PASS`, `WS_SERVER_HOST` y, si se usa, `DEVICE_TOKEN`.
4. Seleccione una placa ESP32 Dev Module y cargue el sketch.

No publique credenciales reales. Use valores locales o un archivo privado de configuración; el firmware incluido utiliza marcadores de posición.

## Modos de operación

0. Espectro Wi‑Fi en 2.4 GHz.
1. Radar de dispositivos BLE.
2. SoftAP y portal cautivo para una red propia autorizada.
3. Standby y telemetría.

## Uso responsable

El escaneo y el portal cautivo deben utilizarse únicamente en redes propias o con autorización expresa. No se deben suplantar redes de terceros ni recopilar datos personales sin aviso y consentimiento.

## Documentación

El informe y el manual compilados se encuentran en `tesis-latex/`. Para generar los PDF:

```bash
cd tesis-latex
pdflatex main.tex
pdflatex main.tex
cd manual-eilor
pdflatex manual.tex
pdflatex manual.tex
```

## Licencia

Proyecto académico. Añada aquí la licencia institucional que corresponda antes de publicar una versión definitiva.
