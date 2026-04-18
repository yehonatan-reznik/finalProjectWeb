# SkyShield Controller

Use this sketch on the separate ESP32 board that drives the two servos and the laser or LED indicator.

Main endpoints:

- `/status`
- `/health`
- `/config`
- `/center`
- `/set?x=90&y=90`
- `/nudge?dx=5&dy=-5`
- `/servo_up`
- `/servo_down`
- `/step_left`
- `/step_right`
- `/laser_on`
- `/laser_off`
- `/laser_toggle`

Notes:

- The firmware keeps the current web UI endpoints working.
- Servo updates are rate-limited to reduce chatter.
- Startup is safe: servos go to home angles and laser output starts off.
- During bench testing, replace the laser with an LED when possible.
