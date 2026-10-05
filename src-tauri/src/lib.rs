use btleplug::{
    api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType},
    platform::{Manager, Peripheral},
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager as _, State, WindowEvent, Wry,
};
use uuid::Uuid;

const TARGET_NAME: &str = "X382P";
const TARGET_ADDRESS: &str = "ED:83:62:4C:03:13";
const CONTROL_POINT: Uuid = Uuid::from_u128(0x00002ad900001000800000805f9b34fb);
const TREADMILL_DATA: Uuid = Uuid::from_u128(0x00002acd00001000800000805f9b34fb);
const TRAY_ID: &str = "kalwol-status";
const TRAY_SHOW: &str = "tray-show";
const TRAY_QUIT: &str = "tray-quit";

#[derive(Default, Clone)]
pub struct PadState {
    peripheral: Arc<Mutex<Option<Peripheral>>>,
    control: Arc<Mutex<Option<Characteristic>>>,
    latest_telemetry: Arc<Mutex<Option<Telemetry>>>,
    latest_telemetry_at_ms: Arc<AtomicU64>,
    telemetry_transition: Arc<Mutex<()>>,
    operation: Arc<tokio::sync::Mutex<()>>,
    generation: Arc<AtomicU64>,
    control_response: Arc<tokio::sync::Mutex<Option<Vec<u8>>>>,
}

#[derive(Clone)]
struct TrayState {
    connection_item: MenuItem<Wry>,
    speed_item: MenuItem<Wry>,
    session_item: MenuItem<Wry>,
    quit_item: MenuItem<Wry>,
    last_telemetry: Arc<Mutex<Option<TrayTelemetryText>>>,
    last_session: Arc<Mutex<Option<String>>>,
    last_daily_calories: Arc<Mutex<Option<String>>>,
    safe_to_background: Arc<AtomicBool>,
    telemetry_updates: tokio::sync::watch::Sender<(bool, Option<f32>)>,
}

#[derive(Clone, Debug, PartialEq)]
struct TrayTelemetryText {
    connection: String,
    speed: String,
}

#[derive(Serialize, Clone)]
pub struct Connection {
    pub name: String,
    pub connected: bool,
}

#[derive(Serialize, Clone)]
pub struct Telemetry {
    pub speed_kmh: f32,
    pub average_speed_kmh: Option<f32>,
    pub total_distance_m: Option<u32>,
    pub incline_percent: Option<f32>,
    pub elapsed_seconds: Option<u16>,
    pub device_energy_kcal: Option<u16>,
    pub raw: String,
}

#[derive(Serialize)]
pub struct AppStatus {
    pub connected: bool,
    pub telemetry: Option<Telemetry>,
}

fn tray_telemetry_text(connected: bool, speed_kmh: Option<f32>) -> TrayTelemetryText {
    if !connected {
        return TrayTelemetryText {
            connection: "X382P — Hors ligne".into(),
            speed: "Vitesse : —".into(),
        };
    }

    match speed_kmh {
        Some(speed) if speed > 0.05 => TrayTelemetryText {
            connection: "X382P — Connecté".into(),
            speed: format!("Vitesse : {speed:.2} km/h"),
        },
        Some(speed) => TrayTelemetryText {
            connection: "X382P — Connecté".into(),
            speed: format!("Vitesse : {speed:.2} km/h"),
        },
        None => TrayTelemetryText {
            connection: "X382P — Connecté".into(),
            speed: "Vitesse : —".into(),
        },
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn telemetry_is_fresh(observed_at_ms: u64, current_ms: u64) -> bool {
    observed_at_ms > 0 && current_ms.saturating_sub(observed_at_ms) <= 3_000
}

fn safe_to_background(connected: bool, speed_kmh: Option<f32>) -> bool {
    !connected || speed_kmh.is_some_and(|speed| speed <= 0.05)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn update_tray_telemetry(app: &AppHandle, connected: bool, speed_kmh: Option<f32>) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let safe = safe_to_background(connected, speed_kmh);
    state.safe_to_background.store(safe, Ordering::SeqCst);
    let _ = state.telemetry_updates.send((connected, speed_kmh));
}

fn apply_tray_telemetry(app: &AppHandle, connected: bool, speed_kmh: Option<f32>) {
    let presentation = tray_telemetry_text(connected, speed_kmh);
    let safe = safe_to_background(connected, speed_kmh);
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    {
        let Ok(mut previous) = state.last_telemetry.lock() else {
            return;
        };
        if previous.as_ref() == Some(&presentation) {
            return;
        }
        *previous = Some(presentation.clone());
    }

    let _ = state.connection_item.set_text(&presentation.connection);
    let _ = state.speed_item.set_text(&presentation.speed);
    let _ = state.quit_item.set_enabled(safe);
    let _ = state.quit_item.set_text(if safe {
        "Quitter Kalwol Controller"
    } else if speed_kmh.is_some() {
        "Quitter — mettez d’abord le tapis en pause"
    } else {
        "Quitter — télémétrie indisponible"
    });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let (telemetry_updates, mut telemetry_receiver) = tokio::sync::watch::channel((false, None));
    let connection_item = MenuItem::with_id(
        app,
        "tray-connection",
        "X382P — Connexion…",
        false,
        None::<&str>,
    )?;
    let speed_item = MenuItem::with_id(app, "tray-speed", "Vitesse : —", false, None::<&str>)?;
    let session_item = MenuItem::with_id(app, "tray-session", "Séance : —", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let show_item =
        MenuItem::with_id(app, TRAY_SHOW, "Afficher l’application", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(
        app,
        TRAY_QUIT,
        "Quitter Kalwol Controller",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &connection_item,
            &speed_item,
            &session_item,
            &separator,
            &show_item,
            &quit_item,
        ],
    )?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .title("— kcal")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW => show_main_window(app),
            TRAY_QUIT => {
                let safe = app
                    .try_state::<TrayState>()
                    .is_some_and(|state| state.safe_to_background.load(Ordering::SeqCst));
                if safe {
                    quit_cleanly(app.clone());
                } else {
                    show_main_window(app);
                }
            }
            _ => {}
        })
        .build(app)?;

    app.manage(TrayState {
        connection_item,
        speed_item,
        session_item,
        quit_item,
        last_telemetry: Arc::new(Mutex::new(None)),
        last_session: Arc::new(Mutex::new(None)),
        last_daily_calories: Arc::new(Mutex::new(None)),
        safe_to_background: Arc::new(AtomicBool::new(false)),
        telemetry_updates,
    });
    let tray_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        while telemetry_receiver.changed().await.is_ok() {
            let (connected, speed_kmh) = *telemetry_receiver.borrow_and_update();
            let update_app = tray_app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                apply_tray_telemetry(&update_app, connected, speed_kmh);
            })
            .await;
        }
    });
    Ok(())
}

fn quit_cleanly(app: AppHandle) {
    let Some(state) = app.try_state::<PadState>() else {
        app.exit(0);
        return;
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = disconnect_impl(&app, &state).await;
        app.exit(0);
    });
}

fn format_tray_duration(total_seconds: u32) -> String {
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}")
    } else {
        format!("{minutes} min")
    }
}

#[tauri::command]
fn update_tray_session(
    duration_seconds: Option<u32>,
    distance_m: Option<u32>,
    active_calories: Option<f64>,
    app: AppHandle,
) -> Result<(), String> {
    let text = tray_session_text(duration_seconds, distance_m, active_calories)?;
    let state = app
        .try_state::<TrayState>()
        .ok_or_else(|| "tray indicator unavailable".to_string())?;
    {
        let mut previous = state
            .last_session
            .lock()
            .map_err(|_| "tray state lock failed")?;
        if previous.as_ref() == Some(&text) {
            return Ok(());
        }
        *previous = Some(text.clone());
    }
    state
        .session_item
        .set_text(&text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_tray_daily_calories(active_calories: Option<f64>, app: AppHandle) -> Result<(), String> {
    let title = daily_calories_title(active_calories)?;
    let state = app
        .try_state::<TrayState>()
        .ok_or_else(|| "tray indicator unavailable".to_string())?;
    {
        let mut previous = state
            .last_daily_calories
            .lock()
            .map_err(|_| "tray state lock failed")?;
        if previous.as_ref() == Some(&title) {
            return Ok(());
        }
        *previous = Some(title.clone());
    }
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray indicator unavailable".to_string())?;
    tray.set_title(Some(&title))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn daily_calories_title(active_calories: Option<f64>) -> Result<String, String> {
    if active_calories
        .is_some_and(|value| !value.is_finite() || !(0.0..=100_000.0).contains(&value))
    {
        return Err("invalid daily calorie estimate".into());
    }
    Ok(active_calories
        .map(|value| format!("{value:.0} kcal"))
        .unwrap_or_else(|| "— kcal".into()))
}

fn tray_session_text(
    duration_seconds: Option<u32>,
    distance_m: Option<u32>,
    active_calories: Option<f64>,
) -> Result<String, String> {
    if duration_seconds.is_some_and(|value| value > 65_535)
        || distance_m.is_some_and(|value| value > 16_777_215)
    {
        return Err("invalid tray session counters".into());
    }
    if active_calories
        .is_some_and(|value| !value.is_finite() || !(0.0..=100_000.0).contains(&value))
    {
        return Err("invalid tray calorie estimate".into());
    }

    let (Some(duration_seconds), Some(distance_m)) = (duration_seconds, distance_m) else {
        return Ok("Séance : —".into());
    };
    let calories = active_calories
        .map(|value| format!("{value:.0} kcal"))
        .unwrap_or_else(|| "— kcal".into());
    Ok(format!(
        "Séance : {} · {:.2} km · {calories}",
        format_tray_duration(duration_seconds),
        distance_m as f64 / 1000.0,
    ))
}

fn connected_pad(state: &PadState) -> Result<(Peripheral, Characteristic), String> {
    let peripheral = state
        .peripheral
        .lock()
        .map_err(|_| "state lock failed")?
        .clone()
        .ok_or("not connected")?;
    let control = state
        .control
        .lock()
        .map_err(|_| "state lock failed")?
        .clone()
        .ok_or("control point unavailable")?;
    Ok((peripheral, control))
}

async fn find_characteristic(
    peripheral: &Peripheral,
    uuid: Uuid,
) -> Result<Characteristic, String> {
    peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == uuid)
        .ok_or_else(|| format!("missing characteristic {uuid}"))
}

#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, PadState>) -> Result<Connection, String> {
    let result = connect_impl(app.clone(), &state).await;
    if result.is_err() {
        update_tray_telemetry(&app, false, None);
    }
    result
}

async fn connect_impl(app: AppHandle, state: &PadState) -> Result<Connection, String> {
    let _operation = state.operation.lock().await;
    let existing_generation = state.generation.load(Ordering::SeqCst);
    let existing = state
        .peripheral
        .lock()
        .map_err(|_| "state lock failed")?
        .clone();
    if let Some(peripheral) = existing {
        if peripheral.is_connected().await.map_err(|e| e.to_string())?
            && state.generation.load(Ordering::SeqCst) == existing_generation
        {
            let connection = Connection {
                name: TARGET_NAME.into(),
                connected: true,
            };
            let speed = if telemetry_is_fresh(
                state.latest_telemetry_at_ms.load(Ordering::SeqCst),
                now_millis(),
            ) {
                state
                    .latest_telemetry
                    .lock()
                    .ok()
                    .and_then(|value| value.as_ref().map(|telemetry| telemetry.speed_kmh))
            } else {
                None
            };
            update_tray_telemetry(&app, true, speed);
            let _ = app.emit("connection", connection.clone());
            return Ok(connection);
        }
    }
    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or("no Bluetooth adapter found")?;
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut peripheral = None;
    for attempt in 0..5 {
        for candidate in adapter.peripherals().await.map_err(|e| e.to_string())? {
            if candidate.address().to_string() == TARGET_ADDRESS {
                peripheral = Some(candidate);
                break;
            }
        }
        if peripheral.is_some() || attempt == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    adapter.stop_scan().await.ok();
    let peripheral = peripheral.ok_or("X382P not found; wake the pad and try again")?;
    if !peripheral.is_connected().await.map_err(|e| e.to_string())? {
        peripheral.connect().await.map_err(|e| e.to_string())?;
    }
    peripheral
        .discover_services()
        .await
        .map_err(|e| e.to_string())?;
    let control = find_characteristic(&peripheral, CONTROL_POINT).await?;
    let data = find_characteristic(&peripheral, TREADMILL_DATA).await?;
    peripheral
        .subscribe(&data)
        .await
        .map_err(|e| e.to_string())?;
    peripheral
        .subscribe(&control)
        .await
        .map_err(|e| e.to_string())?;
    let mut notifications = peripheral
        .notifications()
        .await
        .map_err(|e| e.to_string())?;
    let session_generation = {
        let _transition = state
            .telemetry_transition
            .lock()
            .map_err(|_| "state lock failed")?;
        let session_generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *state.peripheral.lock().map_err(|_| "state lock failed")? = Some(peripheral.clone());
        *state.control.lock().map_err(|_| "state lock failed")? = Some(control);
        update_tray_telemetry(&app, true, None);
        session_generation
    };
    let telemetry_app = app.clone();
    let telemetry_state = state.clone();
    let control_response = state.control_response.clone();
    tokio::spawn(async move {
        while let Some(value) = notifications.next().await {
            if telemetry_state.generation.load(Ordering::SeqCst) != session_generation {
                break;
            }
            if value.uuid == TREADMILL_DATA {
                let Some(telemetry) = parse_telemetry(&value.value) else {
                    continue;
                };
                let accepted = if let Ok(_transition) = telemetry_state.telemetry_transition.lock()
                {
                    if telemetry_state.generation.load(Ordering::SeqCst) != session_generation {
                        false
                    } else {
                        if let Ok(mut latest) = telemetry_state.latest_telemetry.lock() {
                            *latest = Some(telemetry.clone());
                        }
                        telemetry_state
                            .latest_telemetry_at_ms
                            .store(now_millis(), Ordering::SeqCst);
                        update_tray_telemetry(&telemetry_app, true, Some(telemetry.speed_kmh));
                        true
                    }
                } else {
                    false
                };
                if !accepted {
                    break;
                }
                let _ = telemetry_app.emit("telemetry", telemetry);
            } else if value.uuid == CONTROL_POINT && value.value.first() == Some(&0x80) {
                *control_response.lock().await = Some(value.value);
            }
        }

        let ended_current_stream =
            if let Ok(_transition) = telemetry_state.telemetry_transition.lock() {
                if telemetry_state.generation.load(Ordering::SeqCst) == session_generation {
                    telemetry_state.generation.fetch_add(1, Ordering::SeqCst);
                    if let Ok(mut peripheral) = telemetry_state.peripheral.lock() {
                        *peripheral = None;
                    }
                    if let Ok(mut control) = telemetry_state.control.lock() {
                        *control = None;
                    }
                    if let Ok(mut latest) = telemetry_state.latest_telemetry.lock() {
                        *latest = None;
                    }
                    telemetry_state
                        .latest_telemetry_at_ms
                        .store(0, Ordering::SeqCst);
                    true
                } else {
                    false
                }
            } else {
                false
            };
        if ended_current_stream {
            update_tray_telemetry(&telemetry_app, false, None);
            let _ = telemetry_app.emit(
                "connection",
                Connection {
                    name: TARGET_NAME.into(),
                    connected: false,
                },
            );
        }
    });

    let watchdog_app = app.clone();
    let watchdog_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if watchdog_state.generation.load(Ordering::SeqCst) != session_generation {
                return;
            }
            if !telemetry_is_fresh(
                watchdog_state.latest_telemetry_at_ms.load(Ordering::SeqCst),
                now_millis(),
            ) {
                update_tray_telemetry(&watchdog_app, true, None);
            }
        }
    });
    let connection = Connection {
        name: TARGET_NAME.into(),
        connected: true,
    };
    let _ = app.emit("connection", connection.clone());
    Ok(connection)
}

#[tauri::command]
async fn disconnect(app: AppHandle, state: State<'_, PadState>) -> Result<(), String> {
    disconnect_impl(&app, &state).await
}

async fn disconnect_impl(app: &AppHandle, state: &PadState) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let peripheral = {
        let _transition = state
            .telemetry_transition
            .lock()
            .map_err(|_| "state lock failed")?;
        state.generation.fetch_add(1, Ordering::SeqCst);
        let peripheral = state
            .peripheral
            .lock()
            .map_err(|_| "state lock failed")?
            .take();
        *state.control.lock().map_err(|_| "state lock failed")? = None;
        *state
            .latest_telemetry
            .lock()
            .map_err(|_| "state lock failed")? = None;
        state.latest_telemetry_at_ms.store(0, Ordering::SeqCst);
        update_tray_telemetry(app, false, None);
        peripheral
    };
    if let Some(peripheral) = peripheral {
        peripheral.disconnect().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn app_status(app: AppHandle, state: State<'_, PadState>) -> Result<AppStatus, String> {
    let observed_generation = state.generation.load(Ordering::SeqCst);
    let peripheral = state
        .peripheral
        .lock()
        .map_err(|_| "state lock failed")?
        .clone();
    let connected = match peripheral {
        Some(peripheral) => peripheral.is_connected().await.map_err(|e| e.to_string())?,
        None => false,
    } && state.generation.load(Ordering::SeqCst) == observed_generation;
    let fresh = telemetry_is_fresh(
        state.latest_telemetry_at_ms.load(Ordering::SeqCst),
        now_millis(),
    );
    let telemetry = if connected && fresh {
        state
            .latest_telemetry
            .lock()
            .map_err(|_| "state lock failed")?
            .clone()
    } else {
        None
    };
    update_tray_telemetry(
        &app,
        connected,
        telemetry.as_ref().map(|value| value.speed_kmh),
    );
    Ok(AppStatus {
        connected,
        telemetry,
    })
}

#[tauri::command]
async fn set_speed(speed_kmh: f32, state: State<'_, PadState>) -> Result<(), String> {
    let command = encode_speed_command(speed_kmh)?;
    let _operation = state.operation.lock().await;
    let (p, c) = connected_pad(&state)?;
    write_control(&p, &c, &[0x00], &state.control_response).await?;
    write_control(&p, &c, &command, &state.control_response).await
}

#[tauri::command]
async fn machine_command(command: String, state: State<'_, PadState>) -> Result<(), String> {
    let opcode: &[u8] = match command.as_str() {
        "request_control" => &[0x00],
        "start" => &[0x07],
        "pause" => &[0x08, 0x02],
        "stop" => &[0x08, 0x01],
        _ => return Err("unknown machine command".into()),
    };
    let _operation = state.operation.lock().await;
    let (p, c) = connected_pad(&state)?;
    if command == "start" {
        write_control(&p, &c, &[0x00], &state.control_response).await?;
    }
    write_control(&p, &c, opcode, &state.control_response).await
}

fn encode_speed_command(speed_kmh: f32) -> Result<[u8; 3], String> {
    if !speed_kmh.is_finite() || !(0.5..=12.0).contains(&speed_kmh) {
        return Err("speed must be between 0.5 and 12.0 km/h".into());
    }
    let value = (speed_kmh * 100.0).round() as u16;
    Ok([0x02, (value & 0xff) as u8, (value >> 8) as u8])
}

fn validate_control_response(response: &[u8], expected_opcode: u8) -> Result<(), String> {
    if response.len() < 3 || response[0] != 0x80 || response[1] != expected_opcode {
        return Err("invalid FTMS control response".into());
    }
    match response[2] {
        0x01 => Ok(()),
        0x02 => Err("walking pad does not support this command".into()),
        0x03 => Err("walking pad rejected an invalid parameter".into()),
        0x04 => Err("walking pad rejected the command".into()),
        0x05 => Err("walking pad control was not granted".into()),
        result => Err(format!("walking pad returned FTMS error 0x{result:02x}")),
    }
}

async fn write_control(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    command: &[u8],
    response_slot: &tokio::sync::Mutex<Option<Vec<u8>>>,
) -> Result<(), String> {
    *response_slot.lock().await = None;
    peripheral
        .write(characteristic, command, WriteType::WithResponse)
        .await
        .map_err(|e| e.to_string())?;
    let expected_opcode = command[0];
    let response = match tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(response) = response_slot.lock().await.take() {
                if response.get(1) == Some(&expected_opcode) {
                    return response;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    {
        Ok(response) => response,
        Err(_) => {
            let _ = peripheral.disconnect().await;
            return Err("walking pad did not acknowledge the command; connection was reset".into());
        }
    };
    validate_control_response(&response, expected_opcode)
}

fn take_u8(bytes: &[u8], offset: &mut usize) -> Option<u8> {
    let value = *bytes.get(*offset)?;
    *offset += 1;
    Some(value)
}

fn take_u16(bytes: &[u8], offset: &mut usize) -> Option<u16> {
    let value = u16::from_le_bytes([*bytes.get(*offset)?, *bytes.get(*offset + 1)?]);
    *offset += 2;
    Some(value)
}

fn take_i16(bytes: &[u8], offset: &mut usize) -> Option<i16> {
    let value = i16::from_le_bytes([*bytes.get(*offset)?, *bytes.get(*offset + 1)?]);
    *offset += 2;
    Some(value)
}

fn take_u24(bytes: &[u8], offset: &mut usize) -> Option<u32> {
    let value = u32::from(*bytes.get(*offset)?)
        | (u32::from(*bytes.get(*offset + 1)?) << 8)
        | (u32::from(*bytes.get(*offset + 2)?) << 16);
    *offset += 3;
    Some(value)
}

fn skip(bytes: &[u8], offset: &mut usize, count: usize) -> Option<()> {
    bytes.get(*offset..(*offset + count))?;
    *offset += count;
    Some(())
}

fn parse_telemetry(bytes: &[u8]) -> Option<Telemetry> {
    if bytes.len() < 4 {
        return None;
    }
    let flags = u16::from_le_bytes([bytes[0], bytes[1]]);
    if flags & 1 != 0 {
        return None;
    }

    let mut offset = 2;
    let speed_raw = take_u16(bytes, &mut offset)?;
    if speed_raw == u16::MAX {
        return None;
    }
    let speed_kmh = speed_raw as f32 / 100.0;
    if speed_kmh > 20.0 {
        return None;
    }
    let average_speed_kmh = if flags & (1 << 1) != 0 {
        let value = take_u16(bytes, &mut offset)?;
        (value != u16::MAX).then_some(value as f32 / 100.0)
    } else {
        None
    };
    let total_distance_m = if flags & (1 << 2) != 0 {
        let value = take_u24(bytes, &mut offset)?;
        (value != 0x00ff_ffff).then_some(value)
    } else {
        None
    };
    let incline_percent = if flags & (1 << 3) != 0 {
        let incline = take_i16(bytes, &mut offset)?;
        skip(bytes, &mut offset, 2)?;
        (incline != i16::MAX).then_some(incline as f32 / 10.0)
    } else {
        None
    };
    if flags & (1 << 4) != 0 {
        skip(bytes, &mut offset, 4)?;
    }
    if flags & (1 << 5) != 0 {
        take_u8(bytes, &mut offset)?;
    }
    if flags & (1 << 6) != 0 {
        take_u8(bytes, &mut offset)?;
    }
    let device_energy_kcal = if flags & (1 << 7) != 0 {
        let total = take_u16(bytes, &mut offset)?;
        skip(bytes, &mut offset, 3)?;
        (total != u16::MAX).then_some(total)
    } else {
        None
    };
    if flags & (1 << 8) != 0 {
        take_u8(bytes, &mut offset)?;
    }
    if flags & (1 << 9) != 0 {
        take_u8(bytes, &mut offset)?;
    }
    let elapsed_seconds = if flags & (1 << 10) != 0 {
        let value = take_u16(bytes, &mut offset)?;
        (value != u16::MAX).then_some(value)
    } else {
        None
    };
    if flags & (1 << 11) != 0 {
        skip(bytes, &mut offset, 2)?;
    }
    if flags & (1 << 12) != 0 {
        skip(bytes, &mut offset, 4)?;
    }

    Some(Telemetry {
        speed_kmh,
        average_speed_kmh,
        total_distance_m,
        incline_percent,
        elapsed_seconds,
        device_energy_kcal,
        raw: bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" "),
    })
}

#[cfg(test)]
fn is_treadmill_data(bytes: &[u8]) -> bool {
    parse_telemetry(bytes).is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PadState::default())
        .setup(|app| {
            if let Err(error) = setup_tray(app) {
                eprintln!("tray indicator unavailable: {error}");
            }
            let handle = app.handle().clone();
            let state = app.state::<PadState>().inner().clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..3 {
                    if connect_impl(handle.clone(), &state).await.is_ok() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                update_tray_telemetry(&handle, false, None);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if window.app_handle().tray_by_id(TRAY_ID).is_some() {
                        api.prevent_close();
                        let safe = window
                            .app_handle()
                            .try_state::<TrayState>()
                            .is_some_and(|state| state.safe_to_background.load(Ordering::SeqCst));
                        if safe {
                            let _ = window.hide();
                        } else {
                            show_main_window(window.app_handle());
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            app_status,
            set_speed,
            machine_command,
            update_tray_session,
            update_tray_daily_calories
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_ftms_speed() {
        assert_eq!(parse_telemetry(&[0, 0, 0x2c, 0x01]).unwrap().speed_kmh, 3.0);
    }
    #[test]
    fn omits_speed_when_more_data_flag_is_set() {
        assert!(parse_telemetry(&[1, 0, 0x2c, 0x01]).is_none());
    }

    #[test]
    fn parses_x382p_session_fields() {
        let packet = [
            0x8c, 0x05, 0xc2, 0x01, 0x18, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5a, 0x00, 0xff,
            0xff, 0xff, 0x00, 0x17, 0x04,
        ];
        let telemetry = parse_telemetry(&packet).unwrap();
        assert_eq!(telemetry.speed_kmh, 4.5);
        assert_eq!(telemetry.total_distance_m, Some(1304));
        assert_eq!(telemetry.incline_percent, Some(0.0));
        assert_eq!(telemetry.elapsed_seconds, Some(1047));
        assert_eq!(telemetry.device_energy_kcal, Some(90));
        assert!(is_treadmill_data(&packet));
    }

    #[test]
    fn ignores_non_treadmill_status_packet() {
        assert!(!is_treadmill_data(&[0x01, 0x20, 0xe0, 0x07, 0x00]));
    }

    #[test]
    fn rejects_truncated_optional_fields() {
        assert!(parse_telemetry(&[0x04, 0x00, 0xc2, 0x01, 0x18]).is_none());
    }

    #[test]
    fn maps_ftms_unavailable_values_to_none() {
        let telemetry = parse_telemetry(&[
            0x0c, 0x04, 0xc2, 0x01, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xff, 0x7f, 0xff, 0xff,
        ])
        .unwrap();
        assert_eq!(telemetry.total_distance_m, None);
        assert_eq!(telemetry.incline_percent, None);
        assert_eq!(telemetry.elapsed_seconds, None);
    }

    #[test]
    fn encodes_four_point_five_kmh_for_ftms() {
        assert_eq!(encode_speed_command(4.5).unwrap(), [0x02, 0xc2, 0x01]);
    }

    #[test]
    fn rejects_unsafe_speed_values() {
        assert!(encode_speed_command(f32::NAN).is_err());
        assert!(encode_speed_command(0.4).is_err());
        assert!(encode_speed_command(12.1).is_err());
    }

    #[test]
    fn validates_control_point_responses() {
        assert!(validate_control_response(&[0x80, 0x02, 0x01], 0x02).is_ok());
        assert!(validate_control_response(&[0x80, 0x02, 0x05], 0x02).is_err());
        assert!(validate_control_response(&[0x80, 0x00, 0x01], 0x02).is_err());
    }

    #[test]
    fn formats_tray_telemetry_states() {
        assert_eq!(
            tray_telemetry_text(false, None).connection,
            "X382P — Hors ligne"
        );
        assert_eq!(tray_telemetry_text(true, None).speed, "Vitesse : —");
        assert_eq!(
            tray_telemetry_text(true, Some(0.0)).speed,
            "Vitesse : 0.00 km/h"
        );
        assert_eq!(
            tray_telemetry_text(true, Some(4.5)).speed,
            "Vitesse : 4.50 km/h"
        );
    }

    #[test]
    fn formats_and_validates_tray_session_summary() {
        assert_eq!(
            tray_session_text(Some(4936), Some(5863), Some(845.4)).unwrap(),
            "Séance : 1:22 · 5.86 km · 845 kcal"
        );
        assert_eq!(tray_session_text(None, None, None).unwrap(), "Séance : —");
        assert!(tray_session_text(Some(65_536), Some(0), Some(0.0)).is_err());
        assert!(tray_session_text(Some(0), Some(0), Some(f64::NAN)).is_err());
    }

    #[test]
    fn formats_and_validates_daily_calorie_title() {
        assert_eq!(daily_calories_title(Some(1097.4)).unwrap(), "1097 kcal");
        assert_eq!(daily_calories_title(None).unwrap(), "— kcal");
        assert!(daily_calories_title(Some(-1.0)).is_err());
    }

    #[test]
    fn treats_old_tray_telemetry_as_stale() {
        assert!(telemetry_is_fresh(10_000, 13_000));
        assert!(!telemetry_is_fresh(10_000, 13_001));
        assert!(!telemetry_is_fresh(0, 10_000));
    }

    #[test]
    fn only_backgrounds_when_stopped_or_disconnected() {
        assert!(safe_to_background(false, None));
        assert!(safe_to_background(true, Some(0.0)));
        assert!(!safe_to_background(true, Some(4.5)));
        assert!(!safe_to_background(true, None));
    }
}
