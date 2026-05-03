#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "secrets.h"

extern "C" {
#include "esp_http_server.h"
}

// AI Thinker ESP32-CAM pin map
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

static httpd_handle_t camera_httpd = nullptr;
static unsigned long lastWifiRetryMs = 0;
static unsigned long lastFirebaseSyncMs = 0;
static bool firebaseSyncPending = false;
static bool lastWifiConnected = false;

#ifndef SKYSHIELD_FIREBASE_DATABASE_URL
#define SKYSHIELD_FIREBASE_DATABASE_URL ""
#endif

#ifndef SKYSHIELD_FIREBASE_AUTH
#define SKYSHIELD_FIREBASE_AUTH ""
#endif

#ifndef SKYSHIELD_FIREBASE_SYNC_INTERVAL_MS
#define SKYSHIELD_FIREBASE_SYNC_INTERVAL_MS 30000UL
#endif

static const char* FIREBASE_DATABASE_URL = SKYSHIELD_FIREBASE_DATABASE_URL;
static const char* FIREBASE_AUTH = SKYSHIELD_FIREBASE_AUTH;
static const unsigned long FIREBASE_SYNC_INTERVAL_MS = SKYSHIELD_FIREBASE_SYNC_INTERVAL_MS;

static String trim_trailing_slashes(const String& raw) {
  String value = raw;
  while (value.endsWith("/")) value.remove(value.length() - 1);
  return value;
}

static bool firebase_enabled() {
  return FIREBASE_DATABASE_URL && FIREBASE_DATABASE_URL[0] != '\0';
}

static String firebase_url(const char* path) {
  String url = trim_trailing_slashes(FIREBASE_DATABASE_URL);
  if (path && *path) {
    if (path[0] != '/') url += '/';
    url += path;
  }
  url += ".json";
  if (FIREBASE_AUTH && FIREBASE_AUTH[0] != '\0') {
    url += "?auth=";
    url += FIREBASE_AUTH;
  }
  return url;
}

static bool firebase_request(const char* method, const char* path, const String* body) {
  if (!firebase_enabled() || WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, firebase_url(path))) return false;
  http.setConnectTimeout(8000);
  http.setTimeout(8000);
  if (body) http.addHeader("Content-Type", "application/json");
  const int statusCode = body
    ? http.sendRequest(method, *body)
    : http.sendRequest(method);
  http.end();
  return statusCode >= 200 && statusCode < 300;
}

static String camera_base_url() {
  return String("http://") + WiFi.localIP().toString();
}

static void request_firebase_sync() {
  firebaseSyncPending = true;
}

static bool publish_firebase_state() {
  if (!firebase_enabled() || WiFi.status() != WL_CONNECTED) return false;
  const String baseUrl = camera_base_url();
  const String rootBody = String("{\"cameraIP\":\"") + baseUrl + "/\"}";
  const String cameraBody =
    String("{\"state\":{\"ip\":\"") + WiFi.localIP().toString() +
    "\",\"urlBase\":\"" + baseUrl +
    "\",\"streamUrl\":\"" + baseUrl + "/stream" +
    "\",\"captureUrl\":\"" + baseUrl + "/capture" +
    "\",\"healthUrl\":\"" + baseUrl + "/health" +
    "\",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? "true" : "false") +
    ",\"rssi\":" + String(WiFi.RSSI()) +
    ",\"heap\":" + String(ESP.getFreeHeap()) +
    ",\"uptimeMs\":" + String(millis()) + "}}";
  const bool rootOk = firebase_request("PATCH", "/", &rootBody);
  const bool cameraOk = firebase_request("PATCH", "/camera", &cameraBody);
  if (rootOk && cameraOk) {
    lastFirebaseSyncMs = millis();
    firebaseSyncPending = false;
    return true;
  }
  return false;
}

static void add_common_headers(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  httpd_resp_set_hdr(req, "Pragma", "no-cache");
}

static esp_err_t index_handler(httpd_req_t* req) {
  static const char PAGE[] PROGMEM =
    "<!doctype html>"
    "<html>"
    "<head>"
    "<meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>ESP32-CAM Stream</title>"
    "<style>"
    "body{margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif;}"
    ".wrap{padding:12px;max-width:980px;margin:0 auto;}"
    ".meta{font-size:14px;opacity:.85;margin-bottom:10px;}"
    "img{width:100%;height:auto;border-radius:8px;border:1px solid #334155;display:block;}"
    "a{color:#38bdf8;text-decoration:none;}"
    "</style>"
    "</head>"
    "<body>"
    "<div class='wrap'>"
    "<h3 style='margin:0 0 8px 0'>ESP32-CAM Live Stream</h3>"
    "<div class='meta'>Endpoints: <a href='/stream'>/stream</a> | <a href='/capture'>/capture</a> | <a href='/health'>/health</a></div>"
    "<img src='/stream' alt='Live stream'>"
    "</div>"
    "</body>"
    "</html>";

  add_common_headers(req);
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  return httpd_resp_send(req, PAGE, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t health_handler(httpd_req_t* req) {
  const String body =
    String("{\"wifi\":") + (WiFi.status() == WL_CONNECTED ? "true" : "false") +
    ",\"ip\":\"" + WiFi.localIP().toString() + "\"" +
    ",\"rssi\":" + String(WiFi.RSSI()) +
    ",\"heap\":" + String(ESP.getFreeHeap()) + "}";

  add_common_headers(req);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_send(req, body.c_str(), body.length());
}

static esp_err_t capture_handler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  add_common_headers(req);
  httpd_resp_set_type(req, "image/jpeg");
  const esp_err_t result = httpd_resp_send(req, reinterpret_cast<const char*>(fb->buf), fb->len);
  esp_camera_fb_return(fb);
  return result;
}

static esp_err_t stream_handler(httpd_req_t* req) {
  static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=frame";
  static const char* STREAM_BOUNDARY = "\r\n--frame\r\n";
  static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

  add_common_headers(req);
  httpd_resp_set_type(req, STREAM_CONTENT_TYPE);

  while (true) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      return ESP_FAIL;
    }

    if (httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY)) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }

    char part_header[64];
    const int header_len = snprintf(part_header, sizeof(part_header), STREAM_PART, fb->len);
    if (httpd_resp_send_chunk(req, part_header, header_len) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }

    if (httpd_resp_send_chunk(req, reinterpret_cast<const char*>(fb->buf), fb->len) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }

    esp_camera_fb_return(fb);
    vTaskDelay(1);
  }

  return ESP_OK;
}

static bool init_camera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
#else
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
#endif
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_CIF;
    config.jpeg_quality = 12;
    config.fb_count = 1;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  const esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_brightness(sensor, 0);
    sensor->set_contrast(sensor, 0);
    sensor->set_saturation(sensor, 0);
  }

  return true;
}

static bool connect_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(SKYSHIELD_WIFI_SSID, SKYSHIELD_WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(400);
    if (millis() - started > 20000UL) {
      Serial.println("\nWi-Fi connect timeout");
      return false;
    }
  }

  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

static void start_camera_server() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t index_uri = {
    .uri = "/",
    .method = HTTP_GET,
    .handler = index_handler,
    .user_ctx = nullptr
  };

  httpd_uri_t health_uri = {
    .uri = "/health",
    .method = HTTP_GET,
    .handler = health_handler,
    .user_ctx = nullptr
  };

  httpd_uri_t capture_uri = {
    .uri = "/capture",
    .method = HTTP_GET,
    .handler = capture_handler,
    .user_ctx = nullptr
  };

  httpd_uri_t stream_uri = {
    .uri = "/stream",
    .method = HTTP_GET,
    .handler = stream_handler,
    .user_ctx = nullptr
  };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &index_uri);
    httpd_register_uri_handler(camera_httpd, &health_uri);
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &stream_uri);
  } else {
    Serial.println("Failed to start HTTP server.");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  Serial.println();

  if (!init_camera()) {
    while (true) {
      delay(1000);
    }
  }

  if (!connect_wifi()) {
    while (true) {
      delay(1000);
    }
  }

  start_camera_server();
  request_firebase_sync();
  publish_firebase_state();

  IPAddress ip = WiFi.localIP();
  Serial.print("Home URL:    http://");
  Serial.println(ip);
  Serial.print("Stream URL:  http://");
  Serial.print(ip);
  Serial.println("/stream");
  Serial.print("Capture URL: http://");
  Serial.print(ip);
  Serial.println("/capture");
  Serial.print("Health URL:  http://");
  Serial.print(ip);
  Serial.println("/health");
}

void loop() {
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (!wifiConnected && millis() - lastWifiRetryMs > 5000UL) {
    lastWifiRetryMs = millis();
    Serial.println("Wi-Fi disconnected, reconnecting...");
    WiFi.disconnect();
    WiFi.begin(SKYSHIELD_WIFI_SSID, SKYSHIELD_WIFI_PASSWORD);
  }

  if (wifiConnected && (!lastWifiConnected || firebaseSyncPending || millis() - lastFirebaseSyncMs >= FIREBASE_SYNC_INTERVAL_MS)) {
    publish_firebase_state();
  }

  lastWifiConnected = wifiConnected;

  delay(250);
}
