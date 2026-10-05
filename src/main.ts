import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  HISTORY_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  applySessionTelemetry,
  appendHistory,
  averageSpeedKmh,
  calorieForecast,
  createHistoryEntry,
  estimateCalories,
  formatDuration,
  historyForLocalDay,
  parseHistory,
  parseProfile,
  parseSession,
  resetSession,
  sessionDistanceM,
  sessionElapsedSeconds,
  type Profile,
  type SessionHistoryEntry,
  type SessionSnapshot,
} from "./session";
import "./style.css";

type Telemetry = {
  speed_kmh: number;
  average_speed_kmh: number | null;
  total_distance_m: number | null;
  incline_percent: number | null;
  elapsed_seconds: number | null;
  device_energy_kcal: number | null;
  raw: string;
};
type Connection = { name: string; connected: boolean };
type AppStatus = { connected: boolean; telemetry: Telemetry | null };

let currentSpeed = 0;
let connected = false;
let lastTelemetryAt = 0;
let profile: Profile = parseProfile(localStorage.getItem(PROFILE_STORAGE_KEY));
let session: SessionSnapshot = parseSession(localStorage.getItem(SESSION_STORAGE_KEY));
let history: SessionHistoryEntry[] = parseHistory(localStorage.getItem(HISTORY_STORAGE_KEY));
let lastTraySession = "";
let lastTrayDailyCalories = "";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <section id="dashboard-view">
      <header>
        <div><p class="eyebrow">KALWOL / FTMS</p><h1>Walking pad</h1></div>
        <button id="open-options" class="icon-button" aria-label="Ouvrir les options">⚙</button>
      </header>
      <div class="connection-line"><span id="status" class="status">Déconnecté</span></div>

      <section class="device card">
        <div><span class="label">Appareil</span><strong id="device">X382P</strong></div>
        <button id="connect" class="secondary">Connecter</button>
      </section>

      <section class="card history-card" aria-label="Historique des séances du jour">
        <div class="history-heading">
          <div><span class="label">Aujourd’hui</span><strong id="history-count">Aucune séance</strong></div>
          <button id="clear-history" class="text-button" hidden>Effacer</button>
        </div>
        <div class="history-totals">
          <div><span>Durée</span><strong id="history-duration">0:00</strong></div>
          <div><span>Distance</span><strong id="history-distance">0.00 km</strong></div>
          <div><span>Moyenne</span><strong id="history-average">—</strong></div>
          <div><span>Calories actives</span><strong id="history-calories">—</strong></div>
        </div>
        <div id="history-list" class="history-list"><p class="history-empty">Les séances terminées apparaîtront ici.</p></div>
        <p class="history-retention">Historique local non chiffré, conservé pendant 31 jours.</p>
      </section>

      <section class="card session-card" aria-label="Résumé de la séance">
        <div class="calorie-heading">
          <div><span class="label">Calories actives estimées</span><div class="calories"><strong id="calories">—</strong><span>kcal</span></div></div>
          <button id="configure-weight" class="text-button">Configurer le poids</button>
        </div>
        <div class="session-stats">
          <div><span>Durée</span><strong id="elapsed">--:--</strong></div>
          <div><span>Vitesse moyenne</span><strong><span id="average-speed">0.00</span> km/h</strong></div>
          <div><span>Distance</span><strong><span id="distance">0.00</span> km</strong></div>
        </div>
        <button id="new-session" class="new-session">Nouvelle séance à partir de maintenant</button>
        <label class="incline-toggle">
          <span><strong>Tapis incliné</strong><small>Réglage manuel pour le calcul</small></span>
          <span class="switch"><input id="incline" type="checkbox"><span class="slider"></span></span>
          <strong id="incline-value">0 %</strong>
        </label>
        <div class="forecast">
          <div class="forecast-heading"><span class="label">Prévision calories actives</span><small>total pour chaque durée</small></div>
          <table aria-label="Prévision des calories actives">
            <thead><tr><th>1 h</th><th>2 h</th><th>3 h</th><th>4 h</th></tr></thead>
            <tbody><tr><td><strong id="forecast-1">—</strong><span> kcal</span></td><td><strong id="forecast-2">—</strong><span> kcal</span></td><td><strong id="forecast-3">—</strong><span> kcal</span></td><td><strong id="forecast-4">—</strong><span> kcal</span></td></tr></tbody>
          </table>
        </div>
      </section>

      <section class="card telemetry">
        <span class="label">Vitesse actuelle</span>
        <div class="speed"><strong id="speed">—</strong><span>km/h</span></div>
        <p id="telemetry-state">Aucune donnée en direct</p>
      </section>

      <section class="card controls">
        <span class="label">Vitesse cible</span>
        <div class="speed-row"><button data-step="-0.5" aria-label="Réduire la vitesse">−</button><input id="speed-input" type="number" min="0.5" max="12" step="0.1" value="4.5" aria-label="Vitesse cible en kilomètres par heure"><button data-step="0.5" aria-label="Augmenter la vitesse">+</button></div>
        <button id="apply" class="primary" disabled>Régler la vitesse</button>
        <div class="actions"><button id="start" disabled>Démarrer</button><button id="pause" disabled>Pause</button><button id="stop" class="danger" disabled>Arrêt</button></div>
      </section>

      <aside class="warning"><strong>Sécurité.</strong> Gardez l’arrêt d’urgence physique accessible. Ne comptez jamais uniquement sur cette application pour arrêter le tapis.</aside>
    </section>

    <section id="options-view" hidden>
      <header>
        <button id="close-options" class="icon-button" aria-label="Retour">←</button>
        <div class="options-title"><p class="eyebrow">PROFIL</p><h1>Options</h1></div>
        <span aria-hidden="true" class="header-spacer"></span>
      </header>
      <section class="card options-card">
        <form id="profile-form">
          <label for="weight"><span class="label">Poids de l’utilisateur</span></label>
          <div class="weight-field"><input id="weight" type="number" min="30" max="250" step="0.1" inputmode="decimal" placeholder="70"><span>kg</span></div>
          <p>Utilisé uniquement sur cet ordinateur pour estimer les calories actives. Valeur acceptée : 30 à 250 kg.</p>
          <button class="primary" type="submit">Enregistrer</button>
        </form>
      </section>
      <section class="card explanation">
        <span class="label">Méthode de calcul</span>
        <p>Estimation basée sur le poids, la durée FTMS, la distance du tapis et la pente sélectionnée. La composante de repos standard ACSM (1 MET) est exclue. Le résultat est recalculé pour toute la séance avec les options actuelles.</p>
      </section>
    </section>
    <button id="always-stop" class="always-stop" hidden>Arrêter le tapis</button>
    <p id="message" class="message" role="status"></p>
  </main>`;

const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const status = $("status");
const connectButton = $<HTMLButtonElement>("connect");
const speedInput = $<HTMLInputElement>("speed-input");
const inclineInput = $<HTMLInputElement>("incline");
const weightInput = $<HTMLInputElement>("weight");
const commandButtons = [
  $<HTMLButtonElement>("apply"),
  $<HTMLButtonElement>("start"),
  $<HTMLButtonElement>("pause"),
  $<HTMLButtonElement>("stop"),
];
const alwaysStopButton = $<HTMLButtonElement>("always-stop");
const newSessionButton = $<HTMLButtonElement>("new-session");

function message(text: string, error = false) {
  $("message").textContent = text;
  $("message").className = `message${error ? " error" : ""}`;
}

function showOptions(show: boolean) {
  $("dashboard-view").hidden = show;
  $("options-view").hidden = !show;
  if (show) {
    renderHistory();
    weightInput.value = profile.weightKg?.toString() ?? "";
    weightInput.focus();
  }
  message("");
}

function setConnected(value: boolean) {
  connected = value;
  status.textContent = value ? "Connecté" : "Déconnecté";
  status.className = `status${value ? " online" : ""}`;
  connectButton.textContent = value ? "Déconnecter" : "Connecter";
  commandButtons.forEach((button) => { button.disabled = !value; });
  alwaysStopButton.hidden = !value;
}

function saveProfile() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

function saveSession() {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function saveHistory(value = history) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch (error) {
    message(`Impossible d’enregistrer l’historique : ${String(error)}`, true);
    return false;
  }
}

function syncTraySession(
  durationSeconds: number | null,
  distanceM: number | null,
  activeCalories: number | null,
) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const payload = { durationSeconds, distanceM, activeCalories };
  const serialized = JSON.stringify(payload);
  if (serialized === lastTraySession) return;
  lastTraySession = serialized;
  void invoke("update_tray_session", payload).catch(() => {
    if (lastTraySession === serialized) lastTraySession = "";
  });
}

function syncTrayDailyCalories(activeCalories: number | null) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const serialized = JSON.stringify(activeCalories);
  if (serialized === lastTrayDailyCalories) return;
  lastTrayDailyCalories = serialized;
  void invoke("update_tray_daily_calories", { activeCalories }).catch(() => {
    if (lastTrayDailyCalories === serialized) lastTrayDailyCalories = "";
  });
}

function archiveCurrentSession() {
  const entry = createHistoryEntry(session, profile);
  if (!entry) return false;
  const nextHistory = appendHistory(history, entry);
  if (!saveHistory(nextHistory)) return false;
  history = nextHistory;
  return true;
}

function makeHistoryRow(entry: SessionHistoryEntry, current: boolean) {
  const row = document.createElement("div");
  row.className = `history-row${current ? " current" : ""}`;

  const description = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = current
    ? "Séance en cours"
    : `Terminée à ${new Date(entry.endedAtMs).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  const details = document.createElement("span");
  details.textContent = `${formatDuration(entry.durationSeconds)} · ${(entry.distanceM / 1000).toFixed(2)} km · ${entry.averageSpeedKmh.toFixed(2)} km/h · pente ${entry.inclinePercent} %`;
  description.append(title, details);

  const calories = document.createElement("strong");
  calories.className = "history-row-calories";
  calories.textContent = entry.activeCalories === null ? "—" : `${entry.activeCalories.toFixed(0)} kcal`;
  row.append(description, calories);
  return row;
}

function renderHistory() {
  const now = new Date();
  const completed = historyForLocalDay(history, now);
  const currentEntry = createHistoryEntry(session, profile);
  const currentToday = currentEntry && historyForLocalDay([currentEntry], now).length > 0
    && !completed.some(({ id }) => id === currentEntry.id)
    ? currentEntry
    : null;
  const entries = currentToday ? [currentToday, ...completed] : completed;
  const duration = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  const distance = entries.reduce((total, entry) => total + entry.distanceM, 0);
  const caloriesKnown = entries.every((entry) => entry.activeCalories !== null);
  const calories = caloriesKnown
    ? entries.reduce((total, entry) => total + (entry.activeCalories ?? 0), 0)
    : null;
  const average = duration > 0 ? (distance * 3.6) / duration : null;
  syncTrayDailyCalories(calories);

  $("history-count").textContent = entries.length === 0
    ? "Aucune séance"
    : `${entries.length} séance${entries.length > 1 ? "s" : ""}`;
  $("history-duration").textContent = formatDuration(duration);
  $("history-distance").textContent = `${(distance / 1000).toFixed(2)} km`;
  $("history-average").textContent = average === null ? "—" : `${average.toFixed(2)} km/h`;
  $("history-calories").textContent = calories === null ? "—" : `${calories.toFixed(0)} kcal`;
  $("clear-history").toggleAttribute("hidden", history.length === 0);

  const list = $("history-list");
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Les séances terminées apparaîtront ici.";
    list.append(empty);
    return;
  }
  entries.forEach((entry) => list.append(makeHistoryRow(entry, entry === currentToday)));
}

function renderSession() {
  const average = averageSpeedKmh(session);
  const elapsed = sessionElapsedSeconds(session);
  const distance = sessionDistanceM(session);
  const calories = estimateCalories(
    profile.weightKg,
    average,
    elapsed,
    profile.inclinePercent,
  );
  $("elapsed").textContent = formatDuration(elapsed);
  $("average-speed").textContent = average === null ? "—" : average.toFixed(2);
  $("distance").textContent = distance === null ? "—" : (distance / 1000).toFixed(2);
  $("calories").textContent = calories === null ? "—" : calories.toFixed(0);
  const forecastAverage = elapsed === 0 ? null : average;
  calorieForecast(profile.weightKg, forecastAverage, profile.inclinePercent).forEach(({ hours, calories }) => {
    $(`forecast-${hours}`).textContent = calories === null ? "—" : calories.toFixed(0);
  });
  $("configure-weight").toggleAttribute("hidden", profile.weightKg !== null);
  inclineInput.checked = profile.inclinePercent === 5;
  $("incline-value").textContent = `${profile.inclinePercent} %`;
  newSessionButton.disabled = !connected || Date.now() - lastTelemetryAt > 3000;
  syncTraySession(elapsed, distance, calories);
}

function setTelemetry(value: Telemetry) {
  lastTelemetryAt = Date.now();
  currentSpeed = value.speed_kmh;
  $("speed").textContent = currentSpeed.toFixed(2);
  $("telemetry-state").textContent = value.elapsed_seconds === null
    ? "Données reçues • chrono indisponible"
    : `En direct • séance ${formatDuration(value.elapsed_seconds)}`;
  const applied = applySessionTelemetry(session, history, profile, value);
  if (applied.archived && !saveHistory(applied.history)) return;
  history = applied.history;
  session = applied.session;
  saveSession();
  renderSession();
  renderHistory();
}

function clearLiveTelemetry() {
  lastTelemetryAt = 0;
  currentSpeed = 0;
  $("speed").textContent = "—";
  $("telemetry-state").textContent = "Aucune donnée en direct";
  renderSession();
}

function confirmMotion(action: string) {
  return window.confirm(`${action} le tapis ? Vérifiez que la zone est libre et que l’arrêt d’urgence est accessible.`);
}

connectButton.onclick = async () => {
  try {
    if (connected) {
      await invoke("disconnect");
      setConnected(false);
      clearLiveTelemetry();
      message("Bluetooth déconnecté. Le tapis peut continuer à tourner : utilisez l’arrêt physique si nécessaire.");
    } else {
      status.textContent = "Connexion…";
      await invoke("connect");
      setConnected(true);
      message("Tapis connecté.");
    }
  } catch (error) {
    setConnected(false);
    message(String(error), true);
  }
};

document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
  button.onclick = () => {
    speedInput.value = Math.min(12, Math.max(0.5, Number(speedInput.value) + Number(button.dataset.step))).toFixed(1);
  };
});

$("apply").onclick = async () => {
  const value = Number(speedInput.value);
  if (!connected || !Number.isFinite(value)) return;
  try {
    await invoke("set_speed", { speedKmh: value });
    message(`Vitesse réglée à ${value.toFixed(1)} km/h.`);
  } catch (error) {
    message(String(error), true);
  }
};
$("start").onclick = async () => {
  if (!confirmMotion("Démarrer")) return;
  try {
    await invoke("machine_command", { command: "start" });
    message("Commande de démarrage acceptée.");
  } catch (error) {
    message(String(error), true);
  }
};
$("pause").onclick = async () => {
  try {
    await invoke("machine_command", { command: "pause" });
    message("Commande de pause envoyée.");
  } catch (error) {
    message(String(error), true);
  }
};
async function stopPad() {
  try {
    await invoke("machine_command", { command: "stop" });
    message("Commande d’arrêt envoyée.");
  } catch (error) {
    message(String(error), true);
  }
}
$("stop").onclick = stopPad;
alwaysStopButton.onclick = stopPad;

inclineInput.onchange = () => {
  profile.inclinePercent = inclineInput.checked ? 5 : 0;
  saveProfile();
  renderSession();
  renderHistory();
  message(`Pente utilisée pour l’estimation : ${profile.inclinePercent} %.`);
};

$("open-options").onclick = () => showOptions(true);
$("configure-weight").onclick = () => showOptions(true);
$("close-options").onclick = () => showOptions(false);
$("new-session").onclick = () => {
  if (!window.confirm("Remettre à zéro le résumé de séance à partir des compteurs actuels ?")) return;
  const hasSessionToArchive = createHistoryEntry(session, profile) !== null;
  const archived = archiveCurrentSession();
  if (hasSessionToArchive && !archived) return;
  session = resetSession(session);
  saveSession();
  renderSession();
  renderHistory();
  message(archived
    ? "Séance archivée. Une nouvelle séance démarre à partir des compteurs actuels."
    : "Nouvelle séance démarrée à partir des compteurs actuels.");
};
$("clear-history").onclick = () => {
  if (!window.confirm("Effacer toutes les séances terminées de l’historique local ?")) return;
  if (!saveHistory([])) return;
  history = [];
  renderHistory();
  message("Historique des séances terminées effacé.");
};
$<HTMLFormElement>("profile-form").onsubmit = (event) => {
  event.preventDefault();
  const weight = Number(weightInput.value);
  if (!Number.isFinite(weight) || weight < 30 || weight > 250) {
    message("Saisissez un poids compris entre 30 et 250 kg.", true);
    return;
  }
  profile.weightKg = Math.round(weight * 10) / 10;
  saveProfile();
  renderSession();
  renderHistory();
  showOptions(false);
  message(`Poids enregistré : ${profile.weightKg.toFixed(1)} kg.`);
};

async function syncStatus() {
  try {
    const snapshot = await invoke<AppStatus>("app_status");
    setConnected(snapshot.connected);
    if (snapshot.telemetry) setTelemetry(snapshot.telemetry);
    else clearLiveTelemetry();
  } catch (error) {
    message(String(error), true);
  }
}

async function pollStatus() {
  await syncStatus();
  window.setTimeout(pollStatus, 500);
}

saveHistory();
renderSession();
renderHistory();
if ("__TAURI_INTERNALS__" in window) {
  void listen<Connection>("connection", ({ payload }) => setConnected(payload.connected));
  void pollStatus();
}
