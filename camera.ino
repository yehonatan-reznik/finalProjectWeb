#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Bambi2";
const char* password = "bambi567";

// --- AI Thinker pins ---
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
#define LED_GPIO_NUM       4

WebServer server(80);

void handle_root() {
  static const char PROGMEM page[] =
    "<!doctype html><html><head><meta charset='utf-8'>"
    "<title>ESP32-CAM</title>"
    "<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif}main{padding:16px}img{max-width:100%;height:auto;border-radius:8px}</style>"
    "</head><body><main><h2>ESP32-CAM Live (MJPEG)</h2>"
    "<img src='/stream'></main></body></html>";
  server.send_P(200, "text/html", page);
}

void handle_stream() {
  WiFiClient client = server.client();
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=frame");
  client.println("Cache-Control: no-store");
  client.println();

  while (client.connected()) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) continue;
    client.printf("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);
    client.print("\r\n");
    esp_camera_fb_return(fb);
    delay(0); // yield
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_QVGA;   // 320x240 -> low latency
    config.jpeg_quality = 14;               // 10..30 (lower = better)
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size   = FRAMESIZE_QVGA;
    config.jpeg_quality = 15;
    config.fb_count     = 1;
  }
  config.grab_mode = CAMERA_GRAB_LATEST;    // reduce lag

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    while (true) delay(1000);
  }

  // optional sensor tweaks
  sensor_t *s = esp_camera_sensor_get();
  // s->set_vflip(s, 1);    // uncomment if upside-down
  // s->set_hmirror(s, 1);  // uncomment to mirror

  WiFi.begin(ssid, password);
  Serial.printf("Connecting to %s", ssid);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\nWiFi OK. IP: %s\n", WiFi.localIP().toString().c_str());

  server.on("/", handle_root);
  server.on("/stream", HTTP_GET, handle_stream);
  server.begin();
  Serial.println("Open http://<IP>/ in your browser");
}

void loop() { server.handleClient(); }
