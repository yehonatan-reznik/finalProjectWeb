#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>

#include "secrets.h"

#ifndef SKYSHIELD_SERVO_X_PIN
#define SKYSHIELD_SERVO_X_PIN 26
#endif

#ifndef SKYSHIELD_SERVO_Y_PIN
#define SKYSHIELD_SERVO_Y_PIN 27
#endif

#ifndef SKYSHIELD_LASER_PIN
#define SKYSHIELD_LASER_PIN 25
#endif

#ifndef SKYSHIELD_SERVO_MIN_DEG
#define SKYSHIELD_SERVO_MIN_DEG 10
#endif

#ifndef SKYSHIELD_SERVO_MAX_DEG
#define SKYSHIELD_SERVO_MAX_DEG 170
#endif

#ifndef SKYSHIELD_SERVO_HOME_X_DEG
#define SKYSHIELD_SERVO_HOME_X_DEG 90
#endif

#ifndef SKYSHIELD_SERVO_HOME_Y_DEG
#define SKYSHIELD_SERVO_HOME_Y_DEG 90
#endif

#ifndef SKYSHIELD_SERVO_STEP_DEG
#define SKYSHIELD_SERVO_STEP_DEG 5
#endif

#ifndef SKYSHIELD_SERVO_MIN_INTERVAL_MS
#define SKYSHIELD_SERVO_MIN_INTERVAL_MS 80UL
#endif

#ifndef SKYSHIELD_SERVO_X_DIR
#define SKYSHIELD_SERVO_X_DIR 1
#endif

#ifndef SKYSHIELD_SERVO_Y_DIR
#define SKYSHIELD_SERVO_Y_DIR 1
#endif

#ifndef SKYSHIELD_LASER_ACTIVE_HIGH
#define SKYSHIELD_LASER_ACTIVE_HIGH 1
#endif

#ifndef SKYSHIELD_ENABLE_SERVO_OUTPUT
#define SKYSHIELD_ENABLE_SERVO_OUTPUT 1
#endif

#ifndef SKYSHIELD_ENABLE_LASER_OUTPUT
#define SKYSHIELD_ENABLE_LASER_OUTPUT 1
#endif

const int SERVO_X_PIN = SKYSHIELD_SERVO_X_PIN;
const int SERVO_Y_PIN = SKYSHIELD_SERVO_Y_PIN;
const int LASER_PIN = SKYSHIELD_LASER_PIN;

const int SERVO_MIN_DEG = SKYSHIELD_SERVO_MIN_DEG;
const int SERVO_MAX_DEG = SKYSHIELD_SERVO_MAX_DEG;
const int SERVO_HOME_X_DEG = SKYSHIELD_SERVO_HOME_X_DEG;
const int SERVO_HOME_Y_DEG = SKYSHIELD_SERVO_HOME_Y_DEG;
const int SERVO_STEP_DEG = SKYSHIELD_SERVO_STEP_DEG;
const unsigned long SERVO_MIN_INTERVAL_MS = SKYSHIELD_SERVO_MIN_INTERVAL_MS;

const int X_DIR = SKYSHIELD_SERVO_X_DIR;
const int Y_DIR = SKYSHIELD_SERVO_Y_DIR;
const bool LASER_ACTIVE_HIGH = SKYSHIELD_LASER_ACTIVE_HIGH != 0;
const bool SERVO_OUTPUT_ENABLED = SKYSHIELD_ENABLE_SERVO_OUTPUT != 0;
const bool LASER_OUTPUT_ENABLED = SKYSHIELD_ENABLE_LASER_OUTPUT != 0;

WebServer server(80);
Servo servoX;
Servo servoY;

int xAngle = SERVO_HOME_X_DEG;
int yAngle = SERVO_HOME_Y_DEG;
bool laserOn = false;
String lastAction = "boot";
unsigned long lastWifiRetryMs = 0;
unsigned long lastServoWriteMs = 0;
unsigned long lastCommandMs = 0;
unsigned long commandCount = 0;

int clampAngle(int value) {
  if (value < SERVO_MIN_DEG) return SERVO_MIN_DEG;
  if (value > SERVO_MAX_DEG) return SERVO_MAX_DEG;
  return value;
}

unsigned long servoCooldownMs() {
  const unsigned long elapsed = millis() - lastServoWriteMs;
  if (elapsed >= SERVO_MIN_INTERVAL_MS) return 0;
  return SERVO_MIN_INTERVAL_MS - elapsed;
}

void markAction(const char* action) {
  lastAction = action ? action : "unknown";
  lastCommandMs = millis();
  commandCount += 1;
}

void applyServoAngles() {
  if (!SERVO_OUTPUT_ENABLED) return;
  servoX.write(xAngle);
  servoY.write(yAngle);
  lastServoWriteMs = millis();
}

void applyLaserOutput() {
  const int activeLevel = LASER_ACTIVE_HIGH ? HIGH : LOW;
  const int inactiveLevel = LASER_ACTIVE_HIGH ? LOW : HIGH;
  digitalWrite(LASER_PIN, laserOn && LASER_OUTPUT_ENABLED ? activeLevel : inactiveLevel);
}

void setLaser(bool on) {
  laserOn = LASER_OUTPUT_ENABLED ? on : false;
  applyLaserOutput();
}

void addCommonHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
}

String statusJson() {
  return String("{\"x\":") + xAngle +
         ",\"y\":" + yAngle +
         ",\"laser\":" + (laserOn ? "1" : "0") +
         ",\"servo_output_enabled\":" + (SERVO_OUTPUT_ENABLED ? "true" : "false") +
         ",\"laser_output_enabled\":" + (LASER_OUTPUT_ENABLED ? "true" : "false") +
         ",\"servo_cooldown_ms\":" + String(servoCooldownMs()) +
         ",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? "true" : "false") +
         ",\"ip\":\"" + WiFi.localIP().toString() + "\"" +
         ",\"rssi\":" + String(WiFi.RSSI()) +
         ",\"heap\":" + String(ESP.getFreeHeap()) +
         ",\"uptime_ms\":" + String(millis()) +
         ",\"last_action\":\"" + lastAction + "\"" +
         ",\"last_command_ms\":" + String(lastCommandMs) +
         ",\"command_count\":" + String(commandCount) + "}";
}

void sendJson(int statusCode, const String& body) {
  addCommonHeaders();
  server.send(statusCode, "application/json", body);
}

void sendOk(const char* action) {
  markAction(action);
  sendJson(200, String("{\"ok\":true,\"action\":\"") + action + "\",\"state\":" + statusJson() + "}");
}

void sendError(int statusCode, const char* action, const String& message) {
  markAction(action);
  sendJson(statusCode, String("{\"ok\":false,\"action\":\"") + action + "\",\"error\":\"" + message + "\",\"state\":" + statusJson() + "}");
}

bool readIntArg(const char* name, int& out) {
  if (!server.hasArg(name)) return false;
  const String raw = server.arg(name);
  char* endPtr = nullptr;
  const long value = strtol(raw.c_str(), &endPtr, 10);
  if (endPtr == raw.c_str() || *endPtr != '\0') {
    return false;
  }
  out = static_cast<int>(value);
  return true;
}

bool connectWifi() {
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
  Serial.print("Controller IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

bool ensureServoMoveAllowed(const char* action) {
  if (!SERVO_OUTPUT_ENABLED) {
    sendError(409, action, "servo output disabled in firmware config");
    return false;
  }

  const unsigned long cooldown = servoCooldownMs();
  if (cooldown > 0) {
    sendError(429, action, String("servo update rate limited, retry in ") + cooldown + " ms");
    return false;
  }

  return true;
}

void moveToAngles(int nextX, int nextY, const char* action) {
  if (!ensureServoMoveAllowed(action)) return;
  xAngle = clampAngle(nextX);
  yAngle = clampAngle(nextY);
  applyServoAngles();
  sendOk(action);
}

void handleIndex() {
  addCommonHeaders();
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/html; charset=utf-8", "");
  server.sendContent("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>SkyShield Controller</title><style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px;}code,a{color:#38bdf8;}li{margin:6px 0;}pre{white-space:pre-wrap;background:#111827;border:1px solid #334155;padding:12px;border-radius:8px;}</style></head><body>");
  server.sendContent("<h2>SkyShield Controller</h2><p>Two-axis servo controller and laser endpoint for the separate ESP32 board.</p>");
  server.sendContent("<p>Safe notes: use the laser output only for bench tests or replace the module with an LED during integration work.</p>");
  server.sendContent("<h3>Endpoints</h3><ul>");
  server.sendContent("<li><a href='/status'>/status</a></li>");
  server.sendContent("<li><a href='/health'>/health</a></li>");
  server.sendContent("<li><a href='/config'>/config</a></li>");
  server.sendContent("<li><a href='/center'>/center</a> or <a href='/home'>/home</a></li>");
  server.sendContent("<li><code>/set?x=90&y=90</code></li>");
  server.sendContent("<li><code>/nudge?dx=5&dy=-5</code></li>");
  server.sendContent("<li><a href='/servo_up'>/servo_up</a>, <a href='/servo_down'>/servo_down</a>, <a href='/step_left'>/step_left</a>, <a href='/step_right'>/step_right</a></li>");
  server.sendContent("<li><a href='/laser_on'>/laser_on</a>, <a href='/laser_off'>/laser_off</a>, <a href='/laser_toggle'>/laser_toggle</a></li>");
  server.sendContent("</ul><h3>Status</h3><pre>");
  server.sendContent(statusJson());
  server.sendContent("</pre></body></html>");
}

void handleServoUp() {
  moveToAngles(xAngle, yAngle + (SERVO_STEP_DEG * Y_DIR), "servo_up");
}

void handleServoDown() {
  moveToAngles(xAngle, yAngle - (SERVO_STEP_DEG * Y_DIR), "servo_down");
}

void handleStepLeft() {
  moveToAngles(xAngle - (SERVO_STEP_DEG * X_DIR), yAngle, "step_left");
}

void handleStepRight() {
  moveToAngles(xAngle + (SERVO_STEP_DEG * X_DIR), yAngle, "step_right");
}

void handleSetAngles() {
  bool changed = false;
  int nextX = xAngle;
  int nextY = yAngle;
  int value = 0;

  if (server.hasArg("x")) {
    if (!readIntArg("x", value)) {
      sendError(400, "set", "invalid x");
      return;
    }
    nextX = value;
    changed = true;
  }

  if (server.hasArg("y")) {
    if (!readIntArg("y", value)) {
      sendError(400, "set", "invalid y");
      return;
    }
    nextY = value;
    changed = true;
  }

  if (!changed) {
    sendError(400, "set", "expected x and/or y query args");
    return;
  }

  moveToAngles(nextX, nextY, "set");
}

void handleNudge() {
  bool changed = false;
  int dx = 0;
  int dy = 0;

  if (server.hasArg("dx")) {
    if (!readIntArg("dx", dx)) {
      sendError(400, "nudge", "invalid dx");
      return;
    }
    changed = true;
  }

  if (server.hasArg("dy")) {
    if (!readIntArg("dy", dy)) {
      sendError(400, "nudge", "invalid dy");
      return;
    }
    changed = true;
  }

  if (!changed) {
    sendError(400, "nudge", "expected dx and/or dy query args");
    return;
  }

  moveToAngles(xAngle + dx, yAngle + dy, "nudge");
}

void handleCenter() {
  moveToAngles(SERVO_HOME_X_DEG, SERVO_HOME_Y_DEG, "center");
}

void handleStop() {
  setLaser(false);
  sendOk("stop");
}

void handleLaserToggle() {
  if (!LASER_OUTPUT_ENABLED) {
    sendError(409, "laser_toggle", "laser output disabled in firmware config");
    return;
  }
  setLaser(!laserOn);
  sendOk("laser_toggle");
}

void handleLaserOn() {
  if (!LASER_OUTPUT_ENABLED) {
    sendError(409, "laser_on", "laser output disabled in firmware config");
    return;
  }
  setLaser(true);
  sendOk("laser_on");
}

void handleLaserOff() {
  setLaser(false);
  sendOk("laser_off");
}

void handleStatus() {
  sendJson(200, statusJson());
}

void handleHealth() {
  sendJson(200, String("{\"ok\":true,\"status\":") + statusJson() + "}");
}

void handleConfig() {
  const String body =
    String("{\"servo_x_pin\":") + SERVO_X_PIN +
    ",\"servo_y_pin\":" + SERVO_Y_PIN +
    ",\"laser_pin\":" + LASER_PIN +
    ",\"servo_min\":" + SERVO_MIN_DEG +
    ",\"servo_max\":" + SERVO_MAX_DEG +
    ",\"servo_step\":" + SERVO_STEP_DEG +
    ",\"servo_min_interval_ms\":" + SERVO_MIN_INTERVAL_MS +
    ",\"home_x\":" + SERVO_HOME_X_DEG +
    ",\"home_y\":" + SERVO_HOME_Y_DEG +
    ",\"x_dir\":" + X_DIR +
    ",\"y_dir\":" + Y_DIR +
    ",\"servo_output_enabled\":" + (SERVO_OUTPUT_ENABLED ? "true" : "false") +
    ",\"laser_output_enabled\":" + (LASER_OUTPUT_ENABLED ? "true" : "false") + "}";
  sendJson(200, body);
}

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) {
    addCommonHeaders();
    server.send(204, "text/plain", "");
    return;
  }
  sendError(404, "not_found", "not found");
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  Serial.println();

  pinMode(LASER_PIN, OUTPUT);
  setLaser(false);

  if (SERVO_OUTPUT_ENABLED) {
    servoX.setPeriodHertz(50);
    servoY.setPeriodHertz(50);
    servoX.attach(SERVO_X_PIN, 500, 2400);
    servoY.attach(SERVO_Y_PIN, 500, 2400);
    applyServoAngles();
  }

  if (!connectWifi()) {
    while (true) {
      delay(1000);
    }
  }

  server.on("/", handleIndex);
  server.on("/servo_up", handleServoUp);
  server.on("/servo_down", handleServoDown);
  server.on("/step_left", handleStepLeft);
  server.on("/step_right", handleStepRight);
  server.on("/set", handleSetAngles);
  server.on("/nudge", handleNudge);
  server.on("/center", handleCenter);
  server.on("/home", handleCenter);
  server.on("/stop", handleStop);
  server.on("/laser_toggle", handleLaserToggle);
  server.on("/laser_on", handleLaserOn);
  server.on("/laser_off", handleLaserOff);
  server.on("/status", handleStatus);
  server.on("/health", handleHealth);
  server.on("/config", handleConfig);
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("SkyShield controller HTTP server started");
  Serial.println("Endpoints: /status /health /config /center /set?x=..&y=.. /nudge?dx=..&dy=..");
}

void loop() {
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetryMs > 5000UL) {
    lastWifiRetryMs = millis();
    Serial.println("Wi-Fi disconnected, reconnecting...");
    WiFi.disconnect();
    WiFi.begin(SKYSHIELD_WIFI_SSID, SKYSHIELD_WIFI_PASSWORD);
  }
}
