# SkyShield System Diagram

This document summarizes the project flow and the electronic component layout based on the current firmware and web UI.

## Operational flow

```mermaid
flowchart TD
    A[ESP32-CAM\nCamera captures live video] --> B[HTTP stream\n/stream]
    B --> C[Browser control page\ncontrol.html]
    C --> D[TensorFlow.js + COCO-SSD\nanalyze each frame]
    D --> E[Target candidate detected]
    E --> F[Calculate target offset\ncenterX, centerY, dx, dy, normX, normY]
    F --> G[Generate movement guidance\nleft/right/up/down]
    G --> H[Operator Assist panel\nshows move hints]
    H --> I[Operator decides action]
    I --> J[HTTP command to controller ESP32]
    J --> K[ESP32 controller board]
    K --> L[Pan servo moves]
    K --> M[Tilt servo moves]
    K --> N[Laser or LED output]
    L --> O[Camera sees updated scene]
    M --> O
    O --> B
```

## Electronic components diagram

```mermaid
flowchart LR
    subgraph PC[Operator station]
        UI[Browser UI\ncontrol.html]
    end

    subgraph CAM[ESP32-CAM board]
        CAMCPU[ESP32-CAM MCU]
        SENSOR[OV2640 camera module]
        CAMCPU --- SENSOR
    end

    subgraph CTRL[Controller ESP32 board]
        ESP[ESP32 controller]
        SX[Pan servo\nsignal: GPIO26]
        SY[Tilt servo\nsignal: GPIO27]
        LZ[Laser or LED\nsignal: GPIO25]
        ESP --> SX
        ESP --> SY
        ESP --> LZ
    end

    UI <-->|HTTP over Wi-Fi| CAMCPU
    UI <-->|HTTP over Wi-Fi| ESP
```

## Wiring notes

- Controller ESP32 `GPIO26` drives the X-axis servo signal.
- Controller ESP32 `GPIO27` drives the Y-axis servo signal.
- Controller ESP32 `GPIO25` drives the laser or LED output.
- The ESP32-CAM provides the video stream and does not drive the servos directly.
- Use a common ground between the controller ESP32 and the servo power source.
- Powering the servos from an external regulated supply is recommended for stability.

## Source basis

- Controller firmware: `code/firmware/skyshield_controller/skyshield_controller.ino`
- Camera firmware: `code/firmware/ai_thinker_cam_http80/ai_thinker_cam_http80.ino`
- Web UI logic: `code/js/pages/control.js`
