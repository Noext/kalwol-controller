# Kalwol Controller

Small Linux desktop controller for the Kalwol walking pad advertised as `X382P`.

It uses Bluetooth LE Fitness Machine Service (FTMS), not a vendor-specific packet format:

- `0x2ACD` Treadmill Data notifications
- `0x2AD9` Fitness Machine Control Point

## Run

Install the Linux build dependencies first:

```sh
sudo apt install libdbus-1-dev pkg-config libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
```

Then:

```sh
npm install
npm run tauri dev
```

Wake the pad before connecting. The app currently targets one device named `X382P` and uses a conservative 0.5–12 km/h command range. Verify behavior at low speed with the physical emergency stop accessible. This MVP does not replace the emergency stop and has not been validated for unattended operation.
