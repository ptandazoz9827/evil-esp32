#include <WiFi.h>
#include <WebServer.h>       // Servidor HTTP del portal cautivo (incluido con el core ESP32)
#include <DNSServer.h>       // Redirección DNS del portal cautivo (incluido con el core ESP32)
#include <WebSocketsClient.h> // Library: "WebSockets" by Markus Sattler
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <Wire.h>
#include <ezButton.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

/*
 * ==============================================================================
 * EILOR 2.4GHz SUITE - SINCRONIZADA AL 100% CON SERVER.JS (4 MODOS EXACTOS)
 * ==============================================================================
 * MODOS:
 *   [0] Wi-Fi Spectrum      -> Canales 1-13, Congestión y Mini Gráfico OLED
 *   [1] BLE Radar Proximity -> Radar BLE, Detección de Balizas
 *   [2] SoftAP Hotspot      -> Punto de Acceso Clonado, Clientes en vivo
 *   [3] Standby / Telemetry -> Modo Reposo, Enlace WebSocket y Telemetría
 * ==============================================================================
 */

// --- CONFIGURACIÓN WI-FI & SERVIDOR WEBSOCKET ---
const char* WIFI_SSID       = "TU_SSID_WIFI";       // Configurar localmente
const char* WIFI_PASS       = "TU_CLAVE_WIFI";     // No publicar credenciales reales
const char* WS_SERVER_HOST  = "esp.orellanadigitalco.trade"; // Dominio del servidor (túnel)
const int   WS_SERVER_PORT  = 443;                  // Puerto del túnel público (TLS/WSS)

// --- TOKEN DE DISPOSITIVO (opcional) ---------------------------------------
// Déjalo VACÍO ("") mientras la ingestión del server esté abierta (por defecto).
// Cuando arranques el server con la variable de entorno EILOR_DEVICE_TOKEN,
// pon aquí EXACTAMENTE el mismo valor y el ESP32 lo enviará en cada trama.
#define DEVICE_TOKEN ""   // p.ej. "secreto123"

// Devuelve  ,"token":"xxx"  (o cadena vacía si DEVICE_TOKEN está sin configurar)
String tokenField() {
  return (strlen(DEVICE_TOKEN) > 0)
       ? String(",\"token\":\"") + DEVICE_TOKEN + "\""
       : String("");
}

// --- DEFINICIÓN DE PINES ---
#define BUTTON_PIN    15
#define I2C_SDA_PIN   21
#define I2C_SCL_PIN   22

// --- OBJETOS DE HARDWARE ---
ezButton button(BUTTON_PIN);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
WebSocketsClient webSocket;
BLEScan* pBLEScan;

// --- PORTAL CAUTIVO (Modo 2 / SoftAP) ---
const byte DNS_PORT = 53;
DNSServer dnsServer;
WebServer  captiveServer(80);
bool captiveRunning = false;
unsigned int lastRegCount = 0; // registros capturados en esta sesión de AP

// Buffer offline: si el enlace con el servidor se cae, los registros se
// guardan aquí y se reenvían automáticamente al reconectar (no se pierde ninguno).
struct PendingReg { String nombre; String apellido; String telefono; String apSsid; };
const int MAX_PENDING = 20;
PendingReg pendingRegs[MAX_PENDING];
int pendingCount = 0;

// Nombre del negocio que se muestra en el portal (edítalo a tu gusto)
const char* PORTAL_TITULO   = "WiFi de Invitados";
const char* PORTAL_SUBTITULO = "Regístrate para conectarte";

// Escapa comillas/barras para insertar texto de usuario dentro de JSON
String jsonEscape(const String& in) {
  String out;
  out.reserve(in.length() + 4);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in.charAt(i);
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c == '\n' || c == '\r' || c == '\t') { out += ' '; }
    else { out += c; }
  }
  return out;
}

// Construye la trama JSON de un registro para el servidor
String buildRegJson(const String& nombre, const String& apellido, const String& telefono, const String& apSsid) {
  return "{\"type\":\"registration\"" + tokenField() +
         ",\"deviceId\":\"ESP32-EILOR\",\"apSsid\":\"" + jsonEscape(apSsid) + "\"" +
         ",\"nombre\":\"" + jsonEscape(nombre) + "\"" +
         ",\"apellido\":\"" + jsonEscape(apellido) + "\"" +
         ",\"telefono\":\"" + jsonEscape(telefono) + "\"}";
}

// --- ESTADO DEL SISTEMA ---
bool isWsConnected = false;
bool softApActive = false;
String customApSsid = "EILOR-AP-HOTSPOT";
int customApChannel = 6;

// Arreglo de 4 modos idéntico a server.js
const char* modes[] = {
  "Wi-Fi Spectrum",
  "BLE Radar Proximity",
  "SoftAP Hotspot",
  "Standby / Telemetry"
};

uint8_t current_mode = 0; // Inicia por defecto en Modo 0 (Wi-Fi Spectrum)
unsigned long lastScanTime = 0;
unsigned long lastHeartbeatTime = 0;
unsigned long lastOledRefresh = 0;

// Variables de estadísticas para el visualizador OLED
int lastTotalNetworks = 0;
int lastWorstChannel = 6;
int lastWorstCount = 0;
int lastBestChannel = 11;
int channelCounts[14] = {0};
int lastBleCount = 0;
String lastBleTopName = "Ninguno";
int lastBleTopRssi = -100;

// Envía el registro al servidor; si no hay enlace, lo deja en cola.
// (Definidas aquí porque usan isWsConnected/webSocket, ya declarados arriba.)
void queueOrSendReg(const String& nombre, const String& apellido, const String& telefono, const String& apSsid) {
  if (isWsConnected) {
    String j = buildRegJson(nombre, apellido, telefono, apSsid); // local: sendTXT pide String&
    webSocket.sendTXT(j);
  } else if (pendingCount < MAX_PENDING) {
    pendingRegs[pendingCount].nombre   = nombre;
    pendingRegs[pendingCount].apellido = apellido;
    pendingRegs[pendingCount].telefono = telefono;
    pendingRegs[pendingCount].apSsid   = apSsid;
    pendingCount++;
    Serial.printf("[PORTAL] Sin enlace con el servidor: registro en cola (%d pendientes)\n", pendingCount);
  } else {
    Serial.println(F("[PORTAL] Cola llena (20): registro descartado."));
  }
}

// Reenvía todos los registros pendientes cuando se recupera el enlace
void flushPendingRegs() {
  if (!isWsConnected || pendingCount == 0) return;
  Serial.printf("[PORTAL] Reenviando %d registros en cola al servidor...\n", pendingCount);
  for (int i = 0; i < pendingCount; i++) {
    String j = buildRegJson(pendingRegs[i].nombre, pendingRegs[i].apellido,
                            pendingRegs[i].telefono, pendingRegs[i].apSsid);
    webSocket.sendTXT(j);
    delay(30); // pequeño respiro entre tramas
    pendingRegs[i].nombre = ""; pendingRegs[i].apellido = "";
    pendingRegs[i].telefono = ""; pendingRegs[i].apSsid = "";
  }
  pendingCount = 0;
}

// --- RENDERIZADORES OLED PROFESIONALES POR MODO ---

void drawHeader(const char* modeTitle) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print(modeTitle);

  // Indicador de estado WebSocket a la derecha
  display.setCursor(92, 0);
  if (isWsConnected) {
    display.print(F("[WS:OK]"));
  } else {
    display.print(F("[WS:--]"));
  }
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);
}

// 1. OLED: MODO 0 (ESPECTRO WI-FI + GRÁFICO DE 13 CANALES)
void renderSpectrumOled() {
  display.clearDisplay();
  drawHeader("SPECTRUM 2.4G");

  display.setCursor(0, 12);
  display.printf("Total Redes: %d APs\n", lastTotalNetworks);

  display.setCursor(0, 22);
  display.printf("Sat: CH%d (%d APs)\n", lastWorstChannel, lastWorstCount);

  display.setCursor(0, 32);
  display.printf("Recomendado: CH%d\n", lastBestChannel);

  // Mini gráfico de barras horizontal de 13 canales
  display.drawLine(0, 63, 127, 63, SSD1306_WHITE);
  int barWidth = 7;
  int startX = 8;

  for (int c = 1; c <= 13; c++) {
    int x = startX + (c - 1) * 9;
    int h = map(constrain(channelCounts[c], 0, 10), 0, 10, 0, 18);
    if (h > 0) {
      display.fillRect(x, 62 - h, barWidth, h, SSD1306_WHITE);
    } else {
      display.drawPixel(x + 3, 62, SSD1306_WHITE);
    }
  }

  // Marcas de canales 1, 6 y 11
  display.setCursor(startX + 1, 41);
  display.print(F("."));
  display.setCursor(startX + 5 * 9 + 1, 41);
  display.print(F("."));
  display.setCursor(startX + 10 * 9 + 1, 41);
  display.print(F("."));

  display.display();
}

// 2. OLED: MODO 1 (RADAR BLE DE PROXIMIDAD)
void renderBleOled() {
  display.clearDisplay();
  drawHeader("RADAR BLE 2.4G");

  display.setCursor(0, 13);
  display.printf("Dispositivos: %d\n", lastBleCount);

  display.setCursor(0, 25);
  display.printf("Cercano: %s\n", lastBleTopName.substring(0, 10).c_str());

  display.setCursor(0, 37);
  display.printf("RSSI: %d dBm\n", lastBleTopRssi);

  // Animación gráfica de radar circular
  int cx = 105, cy = 36, r = 18;
  display.drawCircle(cx, cy, r, SSD1306_WHITE);
  display.drawCircle(cx, cy, r / 2, SSD1306_WHITE);
  display.drawPixel(cx, cy, SSD1306_WHITE);
  static int radarAngle = 0;
  radarAngle = (radarAngle + 30) % 360;
  float rad = radarAngle * 0.0174533;
  display.drawLine(cx, cy, cx + cos(rad) * r, cy + sin(rad) * r, SSD1306_WHITE);

  display.display();
}

// 3. OLED: MODO 2 (SOFTAP HOTSPOT ACTIVO + CLIENTES EN TIEMPO REAL)
void renderHotspotOled() {
  display.clearDisplay();
  drawHeader("SOFTAP HOTSPOT");

  display.setCursor(0, 12);
  display.print(F("SSID: "));
  display.println(customApSsid.substring(0, 14));

  display.setCursor(0, 22);
  display.printf("Canal: %d | Seg: ABIERTA\n", customApChannel);

  display.setCursor(0, 32);
  display.printf("IP: %s\n", WiFi.softAPIP().toString().c_str());

  // Caja destacada de clientes conectados + registros del portal
  uint8_t stationCount = WiFi.softAPgetStationNum();
  display.drawRoundRect(0, 43, 127, 20, 3, SSD1306_WHITE);
  display.setCursor(6, 47);
  display.printf("Clientes: %d", stationCount);
  display.setCursor(6, 55);
  display.printf("Registros: %d", lastRegCount);

  display.display();
}

// 4. OLED: MODO 3 (STANDBY + ESTADO DE TELEMETRÍA Y ENLACE)
void renderStandbyOled() {
  display.clearDisplay();
  drawHeader("TELEMETRIA WS");

  display.setCursor(0, 13);
  display.printf("Red: %s (%d dBm)\n", WIFI_SSID, WiFi.RSSI());

  display.setCursor(0, 24);
  display.printf("IP: %s\n", WiFi.localIP().toString().c_str());

  display.setCursor(0, 35);
  display.printf("Servidor: :%d\n", WS_SERVER_PORT);

  display.drawFastHLine(0, 46, 127, SSD1306_WHITE);
  display.setCursor(0, 52);
  if (isWsConnected) {
    display.print(F(">> EN LINEA (ACTIVO) <<"));
  } else {
    display.print(F(">> CONECTANDO WS... <<"));
  }

  display.display();
}

void updateOledUI() {
  switch (current_mode) {
    case 0:
      renderSpectrumOled();
      break;
    case 1:
      renderBleOled();
      break;
    case 2:
      renderHotspotOled();
      break;
    case 3:
      renderStandbyOled();
      break;
  }
}

// --- PÁGINAS HTML DEL PORTAL CAUTIVO (en PROGMEM para ahorrar RAM) ---
const char PORTAL_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registro WiFi</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(160deg,#0a1424,#14243d);
color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(0,229,255,.15);border-radius:16px;
padding:28px 24px;width:100%;max-width:380px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:22px;margin-bottom:4px}
.sub{color:#8496b3;font-size:13px;margin-bottom:20px}
label{display:block;font-size:12px;color:#8496b3;margin:12px 0 5px;letter-spacing:.03em}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);
background:#0a1424;color:#f1f5f9;font-size:15px}
input:focus{outline:none;border-color:#00e5ff}
button{width:100%;margin-top:20px;padding:13px;border:none;border-radius:10px;font-size:15px;font-weight:700;
background:linear-gradient(90deg,#00e5ff,#00ff9d);color:#04121f;cursor:pointer}
.note{font-size:11px;color:#4d6280;margin-top:16px;line-height:1.5;text-align:center}
</style></head><body>
<form class="card" method="POST" action="/register">
<h1>__TITULO__</h1>
<p class="sub">__SUBTITULO__</p>
<label>Nombre</label>
<input name="nombre" required maxlength="60" placeholder="Tu nombre" autocomplete="given-name">
<label>Apellido</label>
<input name="apellido" required maxlength="60" placeholder="Tu apellido" autocomplete="family-name">
<label>Teléfono</label>
<input name="telefono" required maxlength="30" type="tel" placeholder="Ej. 099 123 4567" autocomplete="tel">
<button type="submit">Conectarme</button>
<p class="note">Red de invitados. Al registrarte aceptas dejar tus datos de contacto para el acceso.</p>
</form></body></html>
)HTML";

const char THANKS_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registro completado</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(160deg,#0a1424,#14243d);
color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(0,255,157,.25);border-radius:16px;padding:36px 28px;max-width:380px}
h1{font-size:24px;color:#00ff9d;margin-bottom:10px}
p{color:#8496b3;font-size:14px;line-height:1.6}
</style></head><body>
<div class="card"><h1>✅ ¡Listo!</h1>
<p>Tu registro se completó correctamente.<br>Ya puedes navegar. ¡Gracias por visitarnos!</p></div>
</body></html>
)HTML";

// Sirve el formulario, sustituyendo los marcadores de título/subtítulo
void handlePortalRoot() {
  String page = FPSTR(PORTAL_HTML);
  page.replace("__TITULO__", PORTAL_TITULO);
  page.replace("__SUBTITULO__", PORTAL_SUBTITULO);
  captiveServer.send(200, "text/html", page);
}

// Procesa el formulario: reenvía el registro al servidor por WebSocket
void handlePortalRegister() {
  String nombre   = captiveServer.arg("nombre");
  String apellido = captiveServer.arg("apellido");
  String telefono = captiveServer.arg("telefono");

  Serial.printf("[PORTAL] Registro: %s %s | %s\n", nombre.c_str(), apellido.c_str(), telefono.c_str());

  if (nombre.length() || apellido.length() || telefono.length()) {
    queueOrSendReg(nombre, apellido, telefono, customApSsid); // envía o encola si no hay enlace
    lastRegCount++;
  }

  captiveServer.send(200, "text/html", FPSTR(THANKS_HTML));
}

// Cualquier otra URL (incluidas las de detección de portal de los móviles) -> muestra el formulario
void handlePortalNotFound() {
  handlePortalRoot();
}

void startCaptivePortal() {
  if (captiveRunning) return;
  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP()); // todas las consultas DNS -> IP del ESP32

  captiveServer.on("/", handlePortalRoot);
  captiveServer.on("/register", HTTP_POST, handlePortalRegister);
  // Endpoints que usan los sistemas operativos para detectar el portal cautivo
  captiveServer.on("/generate_204", handlePortalRoot);   // Android
  captiveServer.on("/hotspot-detect.html", handlePortalRoot); // iOS/macOS
  captiveServer.on("/ncsi.txt", handlePortalRoot);       // Windows
  captiveServer.onNotFound(handlePortalNotFound);
  captiveServer.begin();

  captiveRunning = true;
  lastRegCount = 0;
  Serial.printf("[PORTAL] Portal cautivo activo en http://%s\n", WiFi.softAPIP().toString().c_str());
}

void stopCaptivePortal() {
  if (!captiveRunning) return;
  captiveServer.stop();
  dnsServer.stop();
  captiveRunning = false;
  Serial.println(F("[PORTAL] Portal cautivo detenido."));
}

// --- GESTIÓN DE SOFTAP ---
void toggleSoftAp(bool enable, String ssid = "", int channel = 6) {
  if (enable) {
    if (ssid.length() > 0) customApSsid = ssid;
    if (channel >= 1 && channel <= 13) customApChannel = channel;

    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(customApSsid.c_str(), NULL, customApChannel, 0, 4);
    softApActive = true;

    Serial.printf("\n[SOFTAP] ✅ Punto de acceso emitido: \"%s\" en Canal %d (IP: %s)\n",
                  customApSsid.c_str(), customApChannel, WiFi.softAPIP().toString().c_str());

    startCaptivePortal(); // levanta el portal cautivo con el formulario de registro
  } else {
    stopCaptivePortal();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    softApActive = false;
    Serial.println(F("[SOFTAP] ⏹ Punto de acceso desactivado."));
  }
  updateOledUI();
}

// --- CAMBIO Y APLICACIÓN DE MODO ---
void applyMode(uint8_t newMode) {
  current_mode = newMode % 4;
  Serial.printf("\n>>> [CAMBIO DE MODO] Activado: Modo %d (%s) <<<\n", current_mode, modes[current_mode]);

  if (current_mode == 2) {
    // Activar SoftAP en Modo 2
    toggleSoftAp(true, customApSsid, customApChannel);
  } else {
    if (softApActive) {
      toggleSoftAp(false);
    }
  }

  updateOledUI();

  // Notificar al servidor de inmediato
  if (isWsConnected) {
    String notifyJson = "{\"action\":\"heartbeat\"" + tokenField() + ",\"deviceId\":\"ESP32-EILOR\",\"status\":\"active\",\"mode\":\"" + String(modes[current_mode]) + "\",\"modeIndex\":" + String(current_mode) + ",\"apActive\":" + (softApActive ? "true" : "false") + ",\"apSsid\":\"" + customApSsid + "\",\"apChannel\":" + String(customApChannel) + ",\"apClients\":" + String(WiFi.softAPgetStationNum()) + "}";
    webSocket.sendTXT(notifyJson);
  }
}

// --- WEBSOCKET EVENT CALLBACK ---
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isWsConnected = false;
      Serial.println(F("[WS] Desconectado del servidor :3002"));
      updateOledUI();
      break;

    case WStype_CONNECTED:
      isWsConnected = true;
      Serial.printf("[WS] ¡Conectado al servidor WebSocket! wss://%s:%d/\n", WS_SERVER_HOST, WS_SERVER_PORT);
      webSocket.sendTXT("{\"action\":\"register\"" + tokenField() + ",\"deviceId\":\"ESP32-EILOR\",\"status\":\"online\",\"mode\":\"" + String(modes[current_mode]) + "\",\"modeIndex\":" + String(current_mode) + "}");
      flushPendingRegs(); // reenvía registros que quedaron en cola mientras no había enlace
      updateOledUI();
      break;

    case WStype_TEXT: {
      String msg = String((char*)payload);

      // Filtro anti-eco: Ignorar eventos de telemetría y logs emitidos por el servidor
      if (msg.indexOf("\"event\":") >= 0 || msg.indexOf("esp32_status_change") >= 0 || msg.indexOf("telemetry_log") >= 0) {
        return;
      }

      Serial.printf("[WS RX] Comando recibido: %s\n", msg.c_str());

      // 1. Comando para crear / clonar SoftAP: {"action":"create_ap","ssid":"pepito","channel":6}
      if (msg.indexOf("create_ap") >= 0 || msg.indexOf("clone_ap") >= 0) {
        int ssidIdx = msg.indexOf("\"ssid\":\"");
        if (ssidIdx >= 0) {
          int endSsid = msg.indexOf("\"", ssidIdx + 8);
          if (endSsid > ssidIdx) {
            customApSsid = msg.substring(ssidIdx + 8, endSsid);
          }
        }
        int chIdx = msg.indexOf("\"channel\":");
        if (chIdx >= 0) {
          customApChannel = msg.substring(chIdx + 10, chIdx + 13).toInt();
          if (customApChannel < 1 || customApChannel > 13) customApChannel = 6;
        }
        applyMode(2); // Cambiar a Modo 2 (SoftAP Hotspot)
        return;
      }

      // 2. Comandos de cambio de modo explícitos (Modos 0 al 3)
      if (msg.indexOf("set_mode") >= 0 || msg.indexOf("change_mode") >= 0 || msg.indexOf("\"cmd\":") >= 0) {
        int targetMode = -1;
        const char* keys[] = {"\"mode\":", "\"modeIndex\":", "\"val\":"};
        for (int k = 0; k < 3; k++) {
          int idx = msg.indexOf(keys[k]);
          if (idx >= 0) {
            int startIdx = idx + strlen(keys[k]);
            while (startIdx < msg.length() && (msg.charAt(startIdx) == ' ' || msg.charAt(startIdx) == '"' || msg.charAt(startIdx) == ':')) {
              startIdx++;
            }
            if (startIdx < msg.length() && msg.charAt(startIdx) >= '0' && msg.charAt(startIdx) <= '3') {
              targetMode = msg.charAt(startIdx) - '0';
              break;
            }
          }
        }

        if (targetMode >= 0 && targetMode <= 3 && targetMode != current_mode) {
          applyMode(targetMode);
        }
      } else if (msg.indexOf("toggle") >= 0) {
        applyMode((current_mode + 1) % 4);
      }
      break;
    }

    case WStype_BIN:
    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
    case WStype_PING:
    case WStype_PONG:
      break;
  }
}

// 1. MODO 0: ANÁLISIS DE ESPECTRO WI-FI Y SATURACIÓN DE CANALES (1-13)
void scanAndAnalyzeSpectrum() {
  int16_t scanStatus = WiFi.scanComplete();

  if (scanStatus == WIFI_SCAN_RUNNING) {
    return;
  }

  if (scanStatus >= 0) {
    int n = scanStatus;
    lastTotalNetworks = n;
    Serial.printf("[SPECTRUM] %d redes detectadas en el espectro 2.4GHz.\n", n);

    for (int c = 1; c <= 13; c++) {
      channelCounts[c] = 0;
    }

    String json = "{\"type\":\"spectrum_wifi\"" + tokenField() + ",\"deviceId\":\"ESP32-EILOR\",\"mode\":\"" + String(modes[current_mode]) + "\",\"modeIndex\":" + String(current_mode) + ",\"total\": " + String(n) + ",\"devices\":[";

    for (int i = 0; i < n; ++i) {
      int ch = WiFi.channel(i);
      int rssi = WiFi.RSSI(i);
      String ssid = WiFi.SSID(i);

      if (ch >= 1 && ch <= 13) {
        channelCounts[ch]++;
      }

      if (i > 0) json += ",";
      json += "{";
      json += "\"ssid\":\"" + ssid + "\",";
      json += "\"bssid\":\"" + WiFi.BSSIDstr(i) + "\",";
      json += "\"rssi\":" + String(rssi) + ",";
      json += "\"channel\":" + String(ch) + ",";
      json += "\"encryption\":\"" + String(WiFi.encryptionType(i)) + "\"";
      json += "}";
    }
    json += "],\"channels\":{";

    int worstCh = 6, bestCh = 11;
    int maxCount = -1, minCount = 999;
    for (int c = 1; c <= 13; c++) {
      if (c > 1) json += ",";
      json += "\"" + String(c) + "\":{\"count\":" + String(channelCounts[c]) + "}";

      if (channelCounts[c] > maxCount) {
        maxCount = channelCounts[c];
        worstCh = c;
      }
      if (channelCounts[c] < minCount && (c == 1 || c == 6 || c == 11)) {
        minCount = channelCounts[c];
        bestCh = c;
      }
    }
    lastWorstChannel = worstCh;
    lastWorstCount = maxCount;
    lastBestChannel = bestCh;

    json += "},\"analysis\":{\"worstChannel\":" + String(worstCh) + ",\"bestChannel\":" + String(bestCh) + "}}";

    updateOledUI();

    if (isWsConnected) {
      webSocket.sendTXT(json);
      Serial.printf("[WS TX] Enviado análisis de espectro Wi-Fi (%d redes).\n", n);
    }

    WiFi.scanDelete();
    WiFi.scanNetworks(true, true);
  } else {
    WiFi.scanNetworks(true, true);
  }
}

// 2. MODO 1: RADAR DE PROXIMIDAD BLUETOOTH LE (BLE)
void scanAndStreamBLE() {
  BLEScanResults foundDevices = pBLEScan->start(2, false);
  int count = foundDevices.getCount();
  lastBleCount = count;

  Serial.printf("[SCAN-BLE] %d balizas BLE detectadas.\n", count);

  if (count > 0) {
    BLEAdvertisedDevice firstDev = foundDevices.getDevice(0);
    lastBleTopName = firstDev.haveName() ? String(firstDev.getName().c_str()) : "Beacon";
    lastBleTopRssi = firstDev.getRSSI();

    String json = "{\"type\":\"ble\"" + tokenField() + ",\"deviceId\":\"ESP32-EILOR\",\"mode\":\"" + String(modes[current_mode]) + "\",\"modeIndex\":" + String(current_mode) + ",\"devices\":[";

    for (int i = 0; i < count; i++) {
      BLEAdvertisedDevice dev = foundDevices.getDevice(i);
      String devName = dev.haveName() ? String(dev.getName().c_str()) : "BLE Beacon";
      String devMac = String(dev.getAddress().toString().c_str());
      int devRssi = dev.getRSSI();

      if (i > 0) json += ",";
      json += "{";
      json += "\"name\":\"" + devName + "\",";
      json += "\"mac\":\"" + devMac + "\",";
      json += "\"rssi\":" + String(devRssi) + ",";
      json += "\"channel\":37";
      json += "}";
    }
    json += "]}";

    updateOledUI();

    if (isWsConnected) {
      webSocket.sendTXT(json);
      Serial.printf("[WS TX] Enviado lote BLE (%d dispositivos).\n", count);
    }
  } else {
    lastBleTopName = "Ninguno";
    lastBleTopRssi = -100;
    updateOledUI();
  }
  pBLEScan->clearResults();
}

void setup() {
  Serial.begin(9600);
  Serial.println(F("\n[ESP32] Iniciando EILOR 2.4G Spectrum & AP Suite..."));

  button.setDebounceTime(50);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print(feragatname);
    display.display();
    delay(800);
  }

  // Iniciar BLE Stack nativo
  Serial.println(F("[BLE] Inicializando BLE Stack..."));
  BLEDevice::init("EILOR-ESP32");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(100);
  pBLEScan->setWindow(99);

  // Configuración de Wi-Fi en modo Station
  WiFi.disconnect(true);
  delay(150);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true); // Coexistencia Wi-Fi / BLE
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.printf("\n[WiFi] Conectando a \"%s\" ...\n", WIFI_SSID);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt < 12000)) {
    delay(400);
    Serial.print(F("."));
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] ¡Conectado! IP local: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());

    webSocket.beginSSL(WS_SERVER_HOST, WS_SERVER_PORT, "/");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(2500);
  } else {
    Serial.printf("\n[WiFi] No se pudo conectar a \"%s\".\n", WIFI_SSID);
  }

  applyMode(current_mode);
}

void loop() {
  webSocket.loop();
  button.loop();

  // Refresco de pantalla OLED cada 500ms para datos en vivo (animaciones y clientes)
  if (millis() - lastOledRefresh > 500) {
    updateOledUI();
    lastOledRefresh = millis();
  }

  // Heartbeat periódico cada 3 segundos hacia el servidor
  if (isWsConnected && (millis() - lastHeartbeatTime > 3000)) {
    webSocket.sendTXT("{\"action\":\"heartbeat\"" + tokenField() + ",\"deviceId\":\"ESP32-EILOR\",\"status\":\"active\",\"mode\":\"" + String(modes[current_mode]) + "\",\"modeIndex\":" + String(current_mode) + ",\"apActive\":" + (softApActive ? "true" : "false") + ",\"apSsid\":\"" + customApSsid + "\",\"apChannel\":" + String(customApChannel) + ",\"apClients\":" + String(WiFi.softAPgetStationNum()) + "}");
    lastHeartbeatTime = millis();
  }

  // Pulsador físico en D15
  if (button.isPressed()) {
    applyMode((current_mode + 1) % 4);
  }

  switch (current_mode) {
    case 0:
      // Mapeo continuo de espectro Wi-Fi (Canales 1-13)
      if (millis() - lastScanTime > 3000) {
        scanAndAnalyzeSpectrum();
        lastScanTime = millis();
      }
      break;

    case 1:
      // Radar continuo de balizas BLE
      if (millis() - lastScanTime > 3000) {
        scanAndStreamBLE();
        lastScanTime = millis();
      }
      break;

    case 2:
      // Modo SoftAP activo: atiende el portal cautivo (DNS + HTTP)
      if (captiveRunning) {
        dnsServer.processNextRequest();
        captiveServer.handleClient();
      }
      break;

    case 3:
      // Standby / Modo reposo
      delay(20);
      break;
  }
}
