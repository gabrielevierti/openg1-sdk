# Documentation

Start here depending on what you are doing.

| | |
| --- | --- |
| **[SIMULATOR_APP.md](SIMULATOR_APP.md)** | Develop without wearing the glasses. Read this first. |
| **[BUILDING_APPS.md](BUILDING_APPS.md)** | Write an app: the framework, four worked patterns, testing. |
| [SIMULATOR.md](SIMULATOR.md) | The simulator in code — panels, reports, what it does not model. |
| [TESTING.md](TESTING.md) | Testing the SDK, and testing your own application. |
| [PROTOCOL.md](PROTOCOL.md) | The wire protocol, every command marked confirmed / observed / guessed. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Corrections, captures, and how the codegen works. |

## The one thing to know

The framebuffer is 576×136. Your eye probably does not get all of it — how the
glasses sit on your face decides how much you see. Measure it once:

```sh
python3 examples/07_calibrate.py --save 23
```

Both the simulator and `display.image()` read that number, so what you build
in the window is what reaches the glass. Everything else in these docs assumes
you have done it.
