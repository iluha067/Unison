/*
 * Unison v3.0.2 - collaborative real-time vault sync (text + binary) + people panel.
 *
 *  - ALL files sync: text as UTF-8, binary (png/jpg/pdf/mp3/...) as base64.
 *    .obsidian and .trash never sync - layouts would fight.
 *  - Right-side "Unison" panel auto-opens on first connect.
 *  - Quiet: no join/leave toasts by default, silent reconcile, delta-sync on
 *    reconnects, heartbeat, unique names, no echo loops.
 *
 * Protocol: JSON over WebSocket, file-update carries {content, encoding}.
 * encoding 'utf8' | 'base64'. No build step: this file is the whole plugin.
 *
 * Source of truth: https://github.com/iluha067/Unison
 */

const { Plugin, ItemView, Notice, PluginSettingTab, Setting, MarkdownView, normalizePath, Modal, setIcon, requestUrl } = require('obsidian');

const VIEW_TYPE_PRESENCE = 'unison-presence';
// Raw GitHub base for self-updates.
const UPDATE_REPO = 'https://raw.githubusercontent.com/iluha067/Unison/main';
// Public Unison relay that hosts rooms so people can join from anywhere.
const OFFICIAL_SERVER = 'ws://94.156.179.131:3000';
// Payment link shown by the "Get Pro" button. Replace with your own page
// (Gumroad, Boosty, Stripe, ...) that delivers a license key after payment.
const BUY_URL = 'https://github.com/iluha067/Unison#plans';
const RECONNECT_MAX = 30000;
const DEBOUNCE_MS = 300;
const CURSOR_THROTTLE_MS = 150;
const CURSOR_RESEND_MS = 10000;
const HEARTBEAT_MS = 20000;
const PERIODIC_SYNC_MS = 5000; // full two-way sweep of all files every 5s
const STALE_MS = 45000;
const SUPPRESS_MS = 3000;
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024; // raw bytes per file; bigger = skipped with log

// Extensions treated as UTF-8 text. Everything else = binary (base64).
const TEXT_EXTS = new Set([
	'md', 'markdown', 'mdx', 'txt', 'canvas', 'json', 'jsonc', 'css', 'js', 'ts',
	'yml', 'yaml', 'toml', 'xml', 'html', 'htm', 'svg', 'py', 'sh', 'c', 'h',
	'cpp', 'java', 'go', 'rs', 'sql', 'log', 'ini', 'cfg', 'env', 'gitignore',
]);

const PALETTE = [
	'#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
	'#009688', '#4caf50', '#ff9800', '#ff5722', '#795548',
	'#607d8b', '#00bcd4', '#8bc34a', '#cddc39', '#ffc107',
];

const DEFAULT_SETTINGS = {
	serverUrl: '',
	room: '',
	user: '',
	userColor: '', // '' = auto (derived from the name)
	token: '',
	apiKey: '', // server API key (API_KEY env on the server); required to connect
	autoConnect: true,
	syncMode: 'all', // 'all' | 'text'
	scopeMode: 'all', // 'all' | 'folders'
	syncFolders: [], // folder paths when scopeMode === 'folders'
	excludePatterns: '.trash/, .smart-env/, .DS_Store, Thumbs.db',
	showNotices: true,
	shareCursor: true,
	showRemoteLines: true, // highlight lines where collaborators stand (CSS only, never touches text)
	lang: '',            // '' = auto (system), 'en', 'ru'
	serverMode: 'hosted', // 'hosted' (built-in relay) | 'custom' (own server)
	license: '',         // Pro license key (unlocks unlimited devices per room)
};

// ---------- i18n ----------
const I18N = {
	en: {
		notConnected: 'Not connected',
		onlineCount: (n) => `${n} online`,
		disconnect: 'Disconnect',
		connect: 'Connect',
		fullSync: 'Full sync with server',
		offlineText: 'No connection to the sync server.',
		nameClash: (n) => `Name "${n}" matches another participant - change it in settings.`,
		people: 'Participants',
		you: 'you',
		inNetwork: 'online',
		typing: 'typing...',
		selected: (n) => `${n} lines selected`,
		goToParticipant: 'Go to participant',
		stateIdle: 'Not synced yet',
		stateOk: (when) => `All synced ${when}`,
		stateJustNow: 'just now',
		stateSecAgo: (s) => `${s}s ago`,
		stateMinAgo: (m) => `${m}m ago`,
		pending: (n) => ` - pending: ${n}`,
		settings: 'Settings',
		name: 'Name',
		color: 'Color',
		nameDesc: 'Shown to other participants. Keep it unique in the room.',
		colorDesc: 'Color of your caret, selection and avatar.',
		auto: 'Auto',
		colorCustom: 'Custom color',
		scope: 'Scope',
		scopeAll: 'Whole vault',
		scopeFolders: (n) => `Folders: ${n}`,
		scopeChange: 'Change...',
		whatToSync: 'What to sync',
		allFiles: 'All files',
		textOnly: 'Text only',
		scopeTitle: 'Sync scope',
		scopeSync: 'Sync',
		scopeAllOpt: 'Whole vault',
		scopeFoldersOpt: 'Selected folders',
		scopeHint: 'Selected folders and their subfolders will be synced.',
		scopeNoFolders: 'No folders in the vault.',
		selectAll: 'Select all',
		clearAll: 'Clear all',
		cancel: 'Cancel',
		restore: 'Restore',
		historyTitle: (p) => `History: ${p}`,
		historyLoading: 'Loading...',
		historyEmpty: 'No saved versions yet (history accumulates on the server).',
		logTitle: 'Unison log',
		langLabel: 'Language',
		langDesc: 'Interface language of Unison.',
		tabTitle: 'Connection',
		tabHint: 'Connection to the sync server. Other settings are in the Unison sidebar.',		serverName: 'WebSocket server',
		serverDesc: 'Server address. You can host your own (see "How to host your own server" below).',
		apiKeyName: 'API key',
		apiKeyDesc: 'Server access key (API_KEY). The server rejects a wrong/missing key.',
		roomName: 'Room',
		roomDesc: 'Shared id. Users with the same server and room see each other.',
		tokenName: 'Room token',
		tokenDesc: 'Optional. If the server sets ROOM_TOKEN it must match.',
		connectToggle: 'Connect / Disconnect',
		autoConnectName: 'Auto-connect',
		autoConnectDesc: 'Connect to the server automatically on startup.',
		updateName: 'Plugin update',
		updateDesc: 'Updates come from GitHub (iluha067/Unison). When a new version exists the plugin notifies you; press this button to download and restart.',
		checkUpdate: 'Check for update',
		guideSummary: 'How to host your own server',
		guideHint: 'Updates are always taken from the official GitHub. Data syncs through any server you host.',
		guideFooter: 'The server file and a ready systemd unit are in the GitHub repository.',
		noticeConnecting: 'Connecting...',
		noticeUpdating: (v) => `Unison updated to v${v}. Restarting Obsidian...`,
		noticeUpToDate: (v) => `Unison: you have the latest version (${v})`,
		noticeUpdateFail: 'Unison: could not check for updates',
		noticeUpdateUrlEmpty: 'Unison: update URL is empty',
		noticeUpdateAvailable: (v, cur) => `Unison: new version v${v} is available (you have ${cur}). Open Settings -> Unison and press "Check for update".`,
		noticeReload: 'Unison: restart Obsidian manually to apply the update',
		noticeLatestDownloaded: (v) => `Unison: v${v} already downloaded, waiting for restart`,
		noticeInvalidKey: 'Invalid API key',
		noticeInvalidToken: 'Invalid room token',
		noticeInvalidRoom: 'Invalid room',
		needServerUrl: 'Unison: set the server URL first (ws://host:port).',
		statusConnected: (n) => `Sync - ${n}`,
		statusOff: 'Sync: off',
		statusReconnect: (s) => `Sync: retry in ${s}s...`,
		statusError: 'Sync: error',
		syncProgress: (d, t) => `Sync ${d}/${t}`,
		syncBusy: (d, t) => `Syncing... ${d}/${t}`,
		notifTitle: 'Unison notification',
		conflictNewer: (p) => `Conflict, your version is newer - sent: ${p}`,
		conflictServerNewer: (p) => `Conflict, server is newer - pulling: ${p}`,
		nameCollision: (p) => `${p}: this name already exists - pulling the shared version`,
		deletedBy: (u, p) => `${u} deleted ${p}`,
		renamedBy: (u, a, b) => `${u} renamed ${a} -> ${b}`,
		merged: (p) => `${p}: merged`,
		restored: (p, v) => `${p}: restored v${v}`,
		restoreFail: 'Unison: failed to restore version',
		inviteCopied: 'Invite copied',
		codeCopied: 'Connection code copied - send it to a friend',
		codeInvalid: 'Unison: invalid connection code',
		codeApplied: 'Unison: settings applied, connecting...',
		quickTitle: 'Quick connect',
		quickHint: 'Paste a connection code from a friend. Server, room and keys will be filled in automatically.',
		quickCode: 'Connection code',
		quickApply: 'Apply and connect',
		copyCodeName: 'Connection code',
		copyCodeDesc: 'Share this code so a friend can connect with one paste.',
		hostSection: 'Host a server (this computer)',
		hostName: 'Host on this computer',
		hostDesc: 'Run the sync server right here and send a friend a single code. Desktop only; the friend must be on the same network unless you forward the port.',
		hostStart: 'Start server',
		hostStop: 'Stop server',
		hostStarting: 'Starting the server...',
		hostStarted: (url) => `Server started. Share: ${url}`,
		hostStopped: 'Server stopped',
		hostFailed: (e) => `Could not start the server: ${e}`,
		hostNotSupported: 'Hosting is not supported on this device.',
		hostMobile: 'Hosting works on desktop only. On mobile, join with a connection code.',
		hostRunning: (url) => `Running at ${url}`,
		hostAddr: (url) => `Address: ${url}`,
		hostInviteName: 'Invite a friend',
		hostInviteDesc: 'Send this code. They install Unison, paste it and connect.',
		copyInvite: 'Copy invite code',
		hostAutoName: 'Start on launch',
		hostAutoDesc: 'Start the server automatically when Obsidian opens.',
		connSection: 'Connection',
		syncSection: 'Sync',
		updateSection: 'Updates',
		roomSection: 'Room',
		modeHosted: 'Unison hosting',
		modeCustom: 'My own server',
		customSection: 'Custom server',
		createRoom: 'Create a room',
		createRoomDesc: 'Start a room on the Unison server and share one code. Anyone, anywhere can join (up to 5 people).',
		roomCreated: 'Room created. Press "Copy invite code" and send it to a friend.',
		joinRoom: 'Join with code',
		shareRoom: 'Share this room',
		shareRoomDesc: 'Send the code. A friend installs Unison, pastes it and joins.',
		peopleMax: (n, max) => `${n} of ${max} online`,
		roomFull: 'Room is full (5 people max).',
		advanced: 'Advanced',
		advancedConn: 'Server, room and keys',
		advancedHost: 'Host on this computer (local network)',
		planSection: 'Plan',
		planFree: 'Free',
		planPro: 'Pro',
		planFreeDesc: 'Up to 5 devices per room.',
		planProDesc: 'Unlimited devices per room. $3 / month.',
		planCurrent: (plan, n, max) => plan === 'pro' ? 'Pro (unlimited devices)' : `Free (${n}/${max} devices)`,
		planLicenseName: 'Pro license key',
		planLicenseDesc: 'Paste the key you received after paying. It unlocks unlimited devices in this room.',
		planBuy: 'Get Pro ($3/month)',
		planBuyHint: 'After payment you receive a license key; paste it below.',
		planThanks: 'Pro activated. Thanks!',
		planFreeActive: 'You are on the Free plan.',
		planSoon: 'Coming soon',
		roomKeyName: 'Room key',
		roomKeyDesc: 'The room secret. Share the invite code; anyone who has it can join.',
		advancedManaged: 'Managed automatically. The server address and keys are filled in for you.',
		profileSection: 'Profile',
		planPerMonth: 'per month',
		planCurrentBadge: 'Current',
		inviteFail: 'Could not copy',
		inviteText: 'Server: {server}\nRoom: {room}\nInstall Unison and enter these. Pick a unique name!',
		invite: 'Copy invite',
		openFileFirst: 'Unison: open a file to see its history',
		fileGone: 'File already deleted: ',
		noConnection: 'Unison: no connection',
		pathLabel: 'Room path',
	},
	ru: {
		notConnected: 'Не подключено',
		onlineCount: (n) => `${n} в сети`,
		disconnect: 'Отключиться',
		connect: 'Подключиться',
		fullSync: 'Полная сверка с сервером',
		offlineText: 'Соединение с сервером не установлено.',
		nameClash: (n) => `Имя «${n}» совпадает с другим участником - смените в настройках.`,
		people: 'Участники',
		you: 'вы',
		inNetwork: 'в сети',
		typing: 'печатает...',
		selected: (n) => `выделено ${n} стр.`,
		goToParticipant: 'Перейти к участнику',
		stateIdle: 'Синхронизация еще не выполнялась',
		stateOk: (when) => `Всё синхронизировано ${when}`,
		stateJustNow: 'только что',
		stateSecAgo: (s) => `${s} с назад`,
		stateMinAgo: (m) => `${m} мин назад`,
		pending: (n) => ` - ожидают: ${n}`,
		settings: 'Настройки',
		name: 'Имя',
		color: 'Цвет',
		nameDesc: 'Отображается другим участникам. Сделайте его уникальным в комнате.',
		colorDesc: 'Цвет вашего курсора, выделения и аватара.',
		auto: 'Авто',
		colorCustom: 'Свой цвет',
		scope: 'Область',
		scopeAll: 'Всё хранилище',
		scopeFolders: (n) => `Папки: ${n}`,
		scopeChange: 'Изменить...',
		whatToSync: 'Что синхронизировать',
		allFiles: 'Все файлы',
		textOnly: 'Только текст',
		scopeTitle: 'Область синхронизации',
		scopeSync: 'Синхронизировать',
		scopeAllOpt: 'Всё хранилище',
		scopeFoldersOpt: 'Выбранные папки',
		scopeHint: 'Содержимое и подпапки выбранных папок будут синхронизироваться.',
		scopeNoFolders: 'В хранилище нет папок.',
		selectAll: 'Выбрать все',
		clearAll: 'Снять все',
		cancel: 'Отмена',
		restore: 'Восстановить',
		historyTitle: (p) => `История: ${p}`,
		historyLoading: 'Загрузка...',
		historyEmpty: 'Пока нет сохранённых версий (история копится на сервере).',
		logTitle: 'Журнал Unison',
		langLabel: 'Язык',
		langDesc: 'Язык интерфейса Unison.',
		tabTitle: 'Подключение',
		tabHint: 'Подключение к серверу синхронизации. Остальные настройки - в боковой панели Unison.',
		serverName: 'Сервер WebSocket',
		serverDesc: 'Адрес сервера. Можно поднять свой (см. «Как поднять свой сервер» ниже).',
		apiKeyName: 'API-ключ',
		apiKeyDesc: 'Ключ доступа к серверу (API_KEY). Без правильного ключа сервер не пустит.',
		roomName: 'Комната',
		roomDesc: 'Общий идентификатор. Участники с одинаковыми сервером и комнатой видят друг друга.',
		tokenName: 'Токен комнаты',
		tokenDesc: 'Необязательно. Если на сервере задан ROOM_TOKEN - должен совпадать.',
		autoConnectName: 'Автоподключение',
		autoConnectDesc: 'Подключаться к серверу автоматически при запуске.',
		updateName: 'Обновление плагина',
		updateDesc: 'Обновления берутся с GitHub (iluha067/Unison). Когда выходит новая версия, плагин сообщает об этом; нажмите кнопку, чтобы скачать и перезапустить.',
		checkUpdate: 'Проверить обновление',
		guideSummary: 'Как поднять свой сервер',
		guideHint: 'Обновления всегда берутся с официального GitHub. Данные синхронизируются через любой ваш сервер.',
		guideFooter: 'Файл сервера и готовый systemd-сервис - в репозитории на GitHub.',
		noticeConnecting: 'Подключение...',
		noticeUpdating: (v) => `Unison обновлён до v${v}. Перезапускаю Obsidian...`,
		noticeUpToDate: (v) => `Unison: у вас последняя версия (${v})`,
		noticeUpdateFail: 'Unison: не удалось проверить обновление',
		noticeUpdateUrlEmpty: 'Unison: не задан адрес обновлений',
		noticeUpdateAvailable: (v, cur) => `Unison: вышла новая версия v${v} (у вас ${cur}). Откройте Настройки -> Unison и нажмите «Проверить обновление».`,
		noticeReload: 'Unison: закройте и откройте Obsidian, чтобы применить обновление',
		noticeLatestDownloaded: (v) => `Unison: v${v} уже загружена, жду перезапуска`,
		noticeInvalidKey: 'Неверный API-ключ',
		noticeInvalidToken: 'Неверный токен комнаты',
		noticeInvalidRoom: 'Неверная комната',
		needServerUrl: 'Unison: сначала задайте адрес сервера (ws://host:port).',
		statusConnected: (n) => `Sync - ${n}`,
		statusOff: 'Sync: откл.',
		statusReconnect: (s) => `Sync: повтор через ${s}с...`,
		statusError: 'Sync: ошибка',
		syncProgress: (d, t) => `Sync ${d}/${t}`,
		syncBusy: (d, t) => `Синхронизация... ${d}/${t}`,
		notifTitle: 'Уведомление Unison',
		conflictNewer: (p) => `Конфликт, твоя версия новее - отправлена: ${p}`,
		conflictServerNewer: (p) => `Конфликт, на сервере новее - забираю: ${p}`,
		nameCollision: (p) => `${p}: такое имя уже есть - забираю общую версию`,
		deletedBy: (u, p) => `${u} удалил ${p}`,
		renamedBy: (u, a, b) => `${u} переименовал ${a} -> ${b}`,
		merged: (p) => `${p}: объединено`,
		restored: (p, v) => `${p}: восстановлена v${v}`,
		restoreFail: 'Unison: не удалось восстановить версию',
		inviteCopied: 'Приглашение скопировано',
		codeCopied: 'Код подключения скопирован - отправьте другу',
		codeInvalid: 'Unison: неверный код подключения',
		codeApplied: 'Unison: настройки применены, подключаюсь...',
		quickTitle: 'Быстрое подключение',
		quickHint: 'Вставьте код подключения от друга.',
		quickCode: 'Код подключения',
		quickApply: 'Применить и подключиться',
		copyCodeName: 'Код подключения',
		copyCodeDesc: 'Передайте этот код другу - он подключится одним вставлением.',
		hostSection: 'Свой сервер (этот компьютер)',
		hostName: 'Запустить сервер на этом компьютере',
		hostDesc: 'Поднять сервер синхронизации прямо здесь и отправить другу один код. Только на ПК; друг должен быть в той же сети, если порт не проброшен.',
		hostStart: 'Запустить сервер',
		hostStop: 'Остановить сервер',
		hostStarting: 'Запускаю сервер...',
		hostStarted: (url) => `Сервер запущен. Поделиться: ${url}`,
		hostStopped: 'Сервер остановлен',
		hostFailed: (e) => `Не удалось запустить сервер: ${e}`,
		hostNotSupported: 'На этом устройстве хостинг недоступен.',
		hostMobile: 'Хостинг работает только на ПК. На телефоне подключайтесь по коду.',
		hostRunning: (url) => `Работает: ${url}`,
		hostAddr: (url) => `Адрес: ${url}`,
		hostInviteName: 'Пригласить друга',
		hostInviteDesc: 'Отправьте этот код. Друг ставит Unison, вставляет код и подключается.',
		copyInvite: 'Скопировать код',
		hostAutoName: 'Запускать при старте',
		hostAutoDesc: 'Автоматически запускать сервер при открытии Obsidian.',
		connSection: 'Подключение',
		syncSection: 'Синхронизация',
		updateSection: 'Обновления',
		roomSection: 'Комната',
		modeHosted: 'Хостинг Unison',
		modeCustom: 'Свой сервер',
		customSection: 'Свой сервер',
		createRoom: 'Создать комнату',
		createRoomDesc: 'Создать комнату на сервере Unison и отправить один код. Подключиться можно откуда угодно (до 5 человек).',
		roomCreated: 'Комната создана. Нажми «Скопировать код» и отправь другу.',
		joinRoom: 'Подключиться по коду',
		shareRoom: 'Поделиться комнатой',
		shareRoomDesc: 'Отправьте код. Друг ставит Unison, вставляет код и подключается.',
		peopleMax: (n, max) => `${n} из ${max} в сети`,
		roomFull: 'Комната заполнена (максимум 5 человек).',
		advanced: 'Дополнительно',
		advancedConn: 'Сервер, комната и ключи',
		advancedHost: 'Сервер на этом компьютере (локальная сеть)',
		planSection: 'Тариф',
		planFree: 'Бесплатный',
		planPro: 'Pro',
		planFreeDesc: 'До 5 устройств на комнату.',
		planProDesc: 'Без ограничений на устройства в комнате. $3 / месяц.',
		planCurrent: (plan, n, max) => plan === 'pro' ? 'Pro (без ограничений)' : `Бесплатный (${n}/${max} устройств)`,
		planLicenseName: 'Ключ Pro',
		planLicenseDesc: 'Вставьте ключ, полученный после оплаты. Он снимает ограничение на число устройств в этой комнате.',
		planBuy: 'Купить Pro ($3/мес)',
		planBuyHint: 'После оплаты ключ придёт на почту; вставьте его ниже.',
		planThanks: 'Pro активирован. Спасибо!',
		planFreeActive: 'У вас бесплатный тариф.',
		planSoon: 'Скоро',
		roomKeyName: 'Ключ комнаты',
		roomKeyDesc: 'Секрет комнаты. Поделитесь кодом-приглашением; кто его знает, тот войдёт.',
		advancedManaged: 'Управляется автоматически. Адрес сервера и ключи подставлены сами.',
		profileSection: 'Профиль',
		planPerMonth: 'в месяц',
		planCurrentBadge: 'Текущий',
		inviteFail: 'Не удалось скопировать',
		inviteText: 'Сервер: {server}\nКомната: {room}\nПоставь плагин Unison и введи эти данные. Имя выбери уникальное!',
		invite: 'Скопировать приглашение',
		openFileFirst: 'Unison: открой файл для просмотра истории',
		fileGone: 'Файл уже удалён: ',
		noConnection: 'Unison: нет подключения',
		pathLabel: 'Путь комнаты',
	},
};

function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

function colorFor(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return PALETTE[h % PALETTE.length];
}

function initials(name) {
	const parts = String(name || '?').trim().split(/[\s\-_]+/).filter(Boolean);
	if (!parts.length) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[1][0]).toUpperCase();
}

function genId() {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function randomName() {
	return 'User-' + Math.random().toString(36).slice(2, 6);
}

function sanitizePath(p) {
	if (!p) return '';
	p = normalizePath(p);
	if (p.startsWith('/') || p.startsWith('./')) p = p.replace(/^\/+/, '').replace(/^\.\/+/, '');
	if (p.includes('..')) return '';
	return p;
}

function extOf(path) {
	const i = path.lastIndexOf('.');
	return i >= 0 ? path.slice(i + 1).toLowerCase() : '';
}

function isTextPath(path) {
	const e = extOf(path);
	if (!e) return true; // extensionless → treat as text
	return TEXT_EXTS.has(e);
}

/** Line union: server text untouched in place, local-only lines appended at end. Idempotent. */
function unionLines(serverText, localText) {
	const set = new Set(serverText.split('\n'));
	const extra = [];
	for (const ln of (localText || '').split('\n')) {
		if (ln.trim() === '') continue;
		if (!set.has(ln)) extra.push(ln);
	}
	if (!extra.length) return serverText;
	return serverText.replace(/\s+$/, '') + '\n' + extra.join('\n') + '\n';
}

/** Normalize selection {a,h} → {from,to} or null (collapsed/invalid). */
function normalizeSel(sel) {
	if (!sel || !sel.a || !sel.h) return null;
	const a = { line: sel.a.line | 0, ch: sel.a.ch | 0 };
	const h = { line: sel.h.line | 0, ch: sel.h.ch | 0 };
	if (a.line === h.line && a.ch === h.ch) return null;
	if (a.line < 0 || h.line < 0 || a.ch < 0 || h.ch < 0) return null;
	return (a.line < h.line || (a.line === h.line && a.ch <= h.ch)) ? { from: a, to: h } : { from: h, to: a };
}
function findInsertIndex(serverLines, localLines, cursorLine) {
	if (!Array.isArray(serverLines)) return 0;
	if (!Array.isArray(localLines)) return serverLines.length;
	if (cursorLine === undefined || cursorLine === null || cursorLine < 0) return serverLines.length;
	const clamp = Math.max(0, Math.min(cursorLine, localLines.length - 1));
	const posMap = new Map();
	serverLines.forEach((ln, i) => {
		if (!posMap.has(ln)) posMap.set(ln, []);
		posMap.get(ln).push(i);
	});
	for (let li = clamp; li >= 0; li--) {
		const ln = localLines[li];
		if (ln.trim() === '' || !posMap.has(ln)) continue;
		let rank = 0;
		for (let i = 0; i <= li; i++) if (localLines[i] === ln) rank++;
		const spots = posMap.get(ln);
		return spots[Math.min(rank, spots.length) - 1] + 1;
	}
	return 0;
}

/** Line diff (LCS, capped) → ops [{t:'eq',len}|{t:'rep',ds,de,ins[]}]. null if too big. */
function diffLineOps(a, b) {
	const n = a.length, m = b.length;
	if (n * m > 900000) return null;
	if (n === 0) return m === 0 ? [] : [{ t: 'rep', ds: 0, de: 0, ins: b.slice() }];
	if (m === 0) return [{ t: 'rep', ds: 0, de: n, ins: [] }];
	const W = m + 1;
	const dp = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
		}
	}
	const ops = [];
	let i = 0, j = 0, eq = 0;
	const flushEq = () => { if (eq > 0) { ops.push({ t: 'eq', len: eq }); eq = 0; } };
	while (i < n && j < m) {
		if (a[i] === b[j]) { eq++; i++; j++; continue; }
		flushEq();
		let rep = ops.length && ops[ops.length - 1].t === 'rep' && ops[ops.length - 1].de === i ? ops[ops.length - 1] : null;
		if (!rep) { rep = { t: 'rep', ds: i, de: i, ins: [] }; ops.push(rep); }
		if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { rep.de++; i++; }
		else { rep.ins.push(b[j]); j++; }
	}
	flushEq();
	if (i < n || j < m) {
		let rep = ops.length && ops[ops.length - 1].t === 'rep' && ops[ops.length - 1].de === i ? ops[ops.length - 1] : null;
		if (!rep) { rep = { t: 'rep', ds: i, de: i, ins: [] }; ops.push(rep); }
		rep.de = n;
		while (j < m) rep.ins.push(b[j++]);
	}
	return ops;
}

/**
 * Three-way line merge: base + local + remote → merged text.
 * - Untouched regions and one-sided edits apply cleanly (typing in the same
 *   line on one side no longer duplicates).
 * - Simultaneous edits of the SAME lines are both kept in canonical
 *   (content-sorted) order, so both sides converge identically - nothing lost.
 * - A line deleted on one side while untouched on the other stays deleted.
 * Falls back to unionLines when the diff is too big.
 */
function threeWayMerge(base, local, remote) {
	if (local === remote) return remote;
	const B = base.split('\n'), L = local.split('\n'), R = remote.split('\n');
	const dL = diffLineOps(B, L), dR = diffLineOps(B, R);
	if (!dL || !dR) return unionLines(remote, local);
	const insL = new Map(), insR = new Map();
	const delL = new Set(), delR = new Set();
	const indexOps = (ops, ins, del) => {
		for (const op of ops) {
			if (op.t !== 'rep') continue;
			if (op.ins.length) {
				if (!ins.has(op.ds)) ins.set(op.ds, []);
				ins.get(op.ds).push(...op.ins);
			}
			for (let k = op.ds; k < op.de; k++) del.add(k);
		}
	};
	indexOps(dL, insL, delL);
	indexOps(dR, insR, delR);
	const out = [];
	for (let g = 0; g <= B.length; g++) {
		const a = insL.get(g) || [], b = insR.get(g) || [];
		if (a.length && b.length) {
			const sa = JSON.stringify(a), sb = JSON.stringify(b);
			if (sa === sb) out.push(...a);
			else if (sa < sb) out.push(...a, ...b);
			else out.push(...b, ...a);
		} else {
			out.push(...a, ...b);
		}
		if (g < B.length && !delL.has(g) && !delR.has(g)) out.push(B[g]);
	}
	let text = out.join('\n');
	if (text && (remote.endsWith('\n') || local.endsWith('\n') || base.endsWith('\n')) && !text.endsWith('\n')) text += '\n';
	return text;
}

/**
 * Merge when the common base is UNKNOWN (we pushed the file ourselves at first
 * sync, so no base was recorded). Never duplicates and never loses lines:
 * local edits replace the lines they correspond to IN PLACE, extra remote lines
 * are kept, extra local lines are appended.
 */
function mergeUnknownBase(remoteText, localText) {
	if (remoteText === localText) return remoteText;
	if (!remoteText) return localText;
	if (!localText) return remoteText;
	const R = remoteText.split('\n');
	const L = localText.split('\n');
	const ops = diffLineOps(R, L);
	if (!ops) return unionLines(remoteText, localText);
	const out = [];
	let i = 0;
	for (const op of ops) {
		if (op.t === 'eq') {
			for (let k = 0; k < op.len; k++) { out.push(R[i]); i++; }
			continue;
		}
		const rm = R.slice(op.ds, op.de);
		const loc = op.ins;
		const pair = Math.min(rm.length, loc.length);
		for (let k = 0; k < pair; k++) out.push(loc[k]);      // local edit wins in place
		for (let k = pair; k < rm.length; k++) out.push(rm[k]); // keep their extra lines
		for (let k = pair; k < loc.length; k++) out.push(loc[k]); // append our extra lines
		i = op.de;
	}
	let text = out.join('\n');
	if (text && (remoteText.endsWith('\n') || localText.endsWith('\n')) && !text.endsWith('\n')) text += '\n';
	return text;
}

/** Anchored insert (no base): local-only lines at cursor anchor. No signature. */
function anchoredInsert(serverText, localText, cursorLine) {
	const serverLines = serverText.split('\n');
	const serverSet = new Set(serverLines);
	const extra = [];
	for (const ln of (localText || '').split('\n')) {
		if (ln.trim() === '') continue;
		if (!serverSet.has(ln)) extra.push(ln);
	}
	if (!extra.length) return serverText;
	const at = findInsertIndex(serverLines, (localText || '').split('\n'), cursorLine);
	const parts = [];
	const before = serverLines.slice(0, at).join('\n').replace(/\s+$/, '');
	const after = serverLines.slice(at).join('\n').replace(/^\s+/, '');
	if (before) parts.push(before);
	parts.push(extra.join('\n'));
	if (after) parts.push(after);
	return parts.join('\n') + '\n';
}

/** Normalize "#abc" / "abc" / "#aabbcc" to "#aabbcc" (lowercase), or '' if invalid. */
function normalizeHex(v) {
	if (!v) return '';
	let s = String(v).trim().replace(/^#/, '');
	if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
	if (!/^[0-9a-fA-F]{6}$/.test(s)) return '';
	return '#' + s.toLowerCase();
}

/** UTF-8 string -> URL-safe base64 (for shareable connection codes). */
function b64urlEncode(str) {
	const bytes = new TextEncoder().encode(str);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 -> UTF-8 string. */
function b64urlDecode(s) {
	let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
	while (b.length % 4) b += '=';
	const bin = atob(b);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

/** ArrayBuffer → base64 (chunked, stack-safe). */
function b64encode(buf) {
	const bytes = new Uint8Array(buf);
	let s = '';
	const CH = 0x8000;
	for (let i = 0; i < bytes.length; i += CH) {
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
	}
	return btoa(s);
}

/** base64 → ArrayBuffer (chunked). */
function b64decode(b64) {
	const s = atob(b64);
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
	return bytes.buffer;
}

class PresenceView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}
	getViewType() { return VIEW_TYPE_PRESENCE; }
	getDisplayText() { return 'Unison'; }
	getIcon() { return 'users'; }
	async onOpen() { this.plugin.presenceView = this; this.render(); }
	async onClose() { if (this.plugin.presenceView === this) this.plugin.presenceView = null; }
	render() {
		try { this._render(); } catch (e) { console.error('[unison] panel render failed', e); }
	}
	_render() {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass('unison-view');
		const p = this.plugin;

		// ── header ──────────────────────────────────────────────
		const head = root.createDiv({ cls: 'unison-head' });
		const title = head.createDiv({ cls: 'unison-head-title' });
		title.createSpan({ cls: 'unison-dot' + (p.connected ? ' online' : '') });
		title.createSpan({ text: p.connected ? p.settings.room : p.t('notConnected'), cls: 'unison-head-name' });
		title.createSpan({ cls: 'unison-version', text: 'v' + ((p.manifest && p.manifest.version) || '?') });
		if (p.roomPlan === 'pro') title.createSpan({ cls: 'unison-version unison-pro', text: 'PRO' });

		const meta = head.createDiv({ cls: 'unison-head-meta' });
		if (p.connected) {
			meta.createSpan({ text: p.roomPlan === 'pro' ? p.t('onlineCount', p.remoteUsers.size + 1) : p.t('peopleMax', p.remoteUsers.size + 1, p.roomLimit || 5) });
			if (p.latency > 0) meta.createSpan({ text: ` · ${p.latency} ms` });
		}

		// ── primary action + share ──────────────────────────────
		const actions = root.createDiv({ cls: 'unison-actions' });
		if (p.connected) {
			this.button(actions, p.t('disconnect'), () => p.disconnect());
			this.button(actions, '', () => p.copyConnectionCode(), 'unison-btn-icon', p.t('copyInvite'), 'share-2');
		} else if (p.settings.serverUrl) {
			this.button(actions, p.t('connect'), () => p.connect(true));
			this.button(actions, '', () => p.quickConnect(), 'unison-btn-icon', p.t('joinRoom'), 'log-in');
		} else {
			this.button(actions, p.t('createRoom'), () => { p.createRoom(); });
			this.button(actions, '', () => p.quickConnect(), 'unison-btn-icon', p.t('joinRoom'), 'log-in');
		}

		if (!p.connected) {
			const box = root.createDiv({ cls: 'unison-offline' });
			box.createDiv({ text: p.t('offlineText'), cls: 'unison-offline-text' });
			if (p.lastError) box.createDiv({ text: p.lastError, cls: 'unison-offline-err' });
		} else {
			if (p.nameClash) {
				root.createDiv({ cls: 'unison-warn' })
					.setText(p.t('nameClash', p.nameClash));
			}

			// ── participants ────────────────────────────────────────
			const list = root.createDiv({ cls: 'unison-people' });
			const all = [
				{ user: p.settings.user, clientId: p.clientId, color: p.color, path: p.myCursor.path, line: p.myCursor.line, sel: p.mySel, self: true, typing: Date.now() - p.lastLocalEditAt < 2500 },
				...[...p.remoteUsers.values()].sort((a, b) => a.user.localeCompare(b.user)).map(u => ({
					...u,
					typing: (p.remoteCursors.get(u.clientId) || {}).typing || u.typing,
					sel: (p.remoteCursors.get(u.clientId) || {}).sel || u.sel,
				})),
			];
			for (const u of all) this.renderUserCard(list, u);
		}

		// ── footer ──────────────────────────────────────────────
		const foot = root.createDiv({ cls: 'unison-foot', text: p.syncStateText() });
		foot.setAttribute('title', p.t('logTitle'));
		foot.onclick = () => new LogModal(this.app, p).open();
	}

	button(parent, label, onClick, extraCls, tooltip, icon) {
		const b = parent.createEl('button', { cls: 'unison-btn' + (extraCls ? ' ' + extraCls : '') });
		if (icon) { try { setIcon(b, icon); } catch (e) { /* ignore */ } }
		if (label) b.createSpan({ text: label });
		if (tooltip) { b.setAttribute('title', tooltip); b.setAttribute('aria-label', tooltip); }
		if (!extraCls || !extraCls.includes('is-disabled')) b.onclick = onClick;
		return b;
	}

	renderUserCard(parent, u) {
		const p = this.plugin;
		const card = parent.createDiv({ cls: 'unison-person' + (u.self ? ' self' : '') + (u.typing ? ' typing' : '') });
		const av = card.createDiv({ cls: 'unison-avatar' });
		av.setText(initials(u.user));
		av.style.background = u.color || colorFor(u.user || '?');
		if (u.typing) av.createSpan({ cls: 'unison-typing-ring' });

		const body = card.createDiv({ cls: 'unison-person-body' });
		const nameRow = body.createDiv({ cls: 'unison-person-name' });
		nameRow.createSpan({ text: u.user });
		if (u.self) nameRow.createSpan({ cls: 'unison-chip', text: p.t('you') });

		const det = body.createDiv({ cls: 'unison-person-sub' });
		if (u.path) {
			det.setText(`${u.path}${u.line ? ':' + (u.line + 1) : ''}`);
			if (!u.self) det.addClass('unison-clickable');
			const bits = [];
			if (u.sel && u.sel.a && u.sel.h) bits.push(p.t('selected', Math.abs(u.sel.h.line - u.sel.a.line) + 1));
			if (u.typing) bits.push(p.t('typing'));
			if (bits.length) body.createDiv({ cls: 'unison-person-note', text: bits.join(' · ') });
		} else {
			det.setText(u.self ? p.t('pathLabel') : p.t('inNetwork'));
		}

		if (!u.self && u.path) {
			card.onclick = () => p.openRemoteCursor(u);
			card.setAttribute('title', p.t('goToParticipant'));
		}
	}
}

class QuickConnectModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const { contentEl } = this;
		const p = this.plugin;
		contentEl.empty();
		contentEl.addClass('unison-history');
		contentEl.createEl('h3', { text: p.t('quickTitle') });
		contentEl.createDiv({ cls: 'unison-folders-hint', text: p.t('quickHint') });

		let input = null;
		new Setting(contentEl)
			.setName(p.t('quickCode'))
			.addTextArea(t => {
				input = t;
				t.setPlaceholder('USYNC1-...');
				try { t.inputEl.rows = 3; t.inputEl.style.width = '100%'; } catch (e) { /* ignore */ }
			});

		new Setting(contentEl)
			.addButton(b => b.setButtonText(p.t('quickApply')).setCta().onClick(() => {
				const val = (input && input.getValue ? input.getValue() : '').trim();
				if (!val) return;
				if (p.applyConnectionCode(val)) this.close();
			}))
			.addButton(b => b.setButtonText(p.t('cancel')).onClick(() => this.close()));
	}
	onClose() { this.contentEl.empty(); }
}

class ScopeModal extends Modal {
	constructor(app, plugin) { super(app); this.plugin = plugin; }
	onOpen() { this.render(); }
	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('unison-history');
		const p = this.plugin;
		contentEl.createEl('h3', { text: p.t('scopeTitle') });

		new Setting(contentEl)
			.setName(p.t('scopeSync'))
			.setDesc(p.t('scopeAll') + ' / ' + p.t('scopeFoldersOpt'))
			.addDropdown(d => d
				.addOption('all', p.t('scopeAllOpt'))
				.addOption('folders', p.t('scopeFoldersOpt'))
				.setValue(p.settings.scopeMode || 'all')
				.onChange(async v => {
					p.settings.scopeMode = v;
					await p.saveSettings();
					this.render();
					p.requestFullSync();
				}));

		if ((p.settings.scopeMode || 'all') !== 'folders') return;

		const folders = p.listFolders();
		contentEl.createDiv({ cls: 'unison-folders-hint', text: folders.length
			? p.t('scopeHint')
			: p.t('scopeNoFolders') });
		if (!folders.length) return;
		const bar = contentEl.createDiv({ cls: 'unison-folders-actions' });
		const all = bar.createEl('button', { text: p.t('selectAll') });
		all.onclick = async () => { p.settings.syncFolders = folders.slice(); await p.saveSettings(); this.render(); p.refreshPresence(); p.requestFullSync(); };
		const none = bar.createEl('button', { text: p.t('clearAll') });
		none.onclick = async () => { p.settings.syncFolders = []; await p.saveSettings(); this.render(); p.refreshPresence(); p.requestFullSync(); };
		for (const folder of folders) {
			new Setting(contentEl)
				.setName(folder)
				.addToggle(t => t
					.setValue((p.settings.syncFolders || []).includes(folder))
					.onChange(async v => {
						let list = (p.settings.syncFolders || []).slice();
						if (v) { if (!list.includes(folder)) list.push(folder); }
						else list = list.filter(x => x !== folder);
						p.settings.syncFolders = list;
						await p.saveSettings();
						p.requestFullSync();
					}));
		}
	}
	onClose() { this.contentEl.empty(); }
}

class UnisonSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();
		containerEl.addClass('unison-settings');

		containerEl.createEl('h2', { text: 'Unison' });
		containerEl.createDiv({ cls: 'unison-settings-hint', text: p.t('tabHint') });

		const h3 = (t) => containerEl.createEl('h3', { cls: 'unison-set-h3', text: t });

		/**
		 * Text fields must apply every keystroke, an instant Ctrl+V paste and
		 * bulk deletions. Obsidian's onChange (blur) only fires when you leave
		 * the field, so we also listen to input / paste / cut / keyup and read
		 * the live value on the next tick (handles whole-paste & mass delete).
		 */
		const bindText = (setting, get, set, extra) => {
			setting.addText(t => {
				t.setPlaceholder((extra && extra.placeholder) || '').setValue(get() || '');
				if (extra && extra.password) { try { t.inputEl.type = 'password'; } catch (e) { /* ignore */ } }
				const apply = async (raw) => { await set(typeof raw === 'string' ? raw.trim() : raw); };
				t.onChange(apply);
				const sync = () => { try { set(t.inputEl.value.trim()); } catch (e) { /* ignore */ } };
				try {
					const el = t.inputEl;
					for (const ev of ['input', 'paste', 'cut', 'keyup', 'drop']) {
						el.addEventListener(ev, () => setTimeout(sync, 0));
					}
					el.addEventListener('change', sync);
				} catch (e) { /* ignore */ }
			});
			return setting;
		};

		// ── server mode: hosted vs custom ──────────────────────
		const modeRow = containerEl.createDiv({ cls: 'unison-seg' });
		const segBtn = (label, value) => {
			const b = modeRow.createEl('button', { cls: 'unison-seg-btn' + (p.settings.serverMode === value ? ' is-active' : ''), text: label });
			b.onclick = async () => {
				if (p.settings.serverMode === value) return;
				p.settings.serverMode = value;
				await p.saveSettings();
				p.disconnect(true);
				this.display();
			};
			return b;
		};
		segBtn(p.t('modeHosted'), 'hosted');
		segBtn(p.t('modeCustom'), 'custom');

		if (p.settings.serverMode === 'custom') {
			// ── custom server ──────────────────────────────────
			h3(p.t('customSection'));
			bindText(new Setting(containerEl)
				.setName(p.t('serverName'))
				.setDesc(p.t('serverDesc')),
				() => p.settings.serverUrl,
				async v => { p.settings.serverUrl = v; await p.saveSettings(); },
				{ placeholder: 'ws://host:3000' });
			bindText(new Setting(containerEl)
				.setName(p.t('apiKeyName'))
				.setDesc(p.t('apiKeyDesc')),
				() => p.settings.apiKey,
				async v => { p.settings.apiKey = v; await p.saveSettings(); },
				{ placeholder: 'key', password: true });
			bindText(new Setting(containerEl)
				.setName(p.t('roomKeyName'))
				.setDesc(p.t('roomKeyDesc')),
				() => p.settings.room,
				async v => { const k = (v || '').trim(); p.settings.room = k || 'default'; p.settings.token = p.settings.room; await p.saveSettings(); },
				{ placeholder: 'unison-...' });
			new Setting(containerEl)
				.setName(p.t('connectToggle'))
				.addButton(b => b.setButtonText(p.connected ? p.t('disconnect') : p.t('connect')).onClick(() => {
					if (p.connected) p.disconnect(true); else p.connect(true);
					this.display();
				}));
			new Setting(containerEl)
				.setName(p.t('autoConnectName'))
				.setDesc(p.t('autoConnectDesc'))
				.addToggle(t => t.setValue(p.settings.autoConnect !== false)
					.onChange(async v => { p.settings.autoConnect = v; await p.saveSettings(); }));
			new Setting(containerEl)
				.setName(p.t('shareRoom'))
				.setDesc(p.t('shareRoomDesc'))
				.addButton(b => b.setButtonText(p.t('copyInvite')).onClick(() => p.copyConnectionCode()));
		} else {
			// ── hosted room ────────────────────────────────────
			h3(p.t('roomSection'));
			new Setting(containerEl)
				.setName(p.t('createRoom'))
				.setDesc(p.t('createRoomDesc'))
				.addButton(b => b.setCta().setButtonText(p.t('createRoom')).onClick(async () => { await p.createRoom(); this.display(); }))
				.addButton(b => b.setButtonText(p.t('joinRoom')).onClick(() => p.quickConnect()));
			new Setting(containerEl)
				.setName(p.t('shareRoom'))
				.setDesc(p.t('shareRoomDesc'))
				.addButton(b => b.setButtonText(p.t('copyInvite')).onClick(() => p.copyConnectionCode()));
			new Setting(containerEl)
				.setName(p.t('autoConnectName'))
				.setDesc(p.t('autoConnectDesc'))
				.addToggle(t => t.setValue(p.settings.autoConnect !== false)
					.onChange(async v => { p.settings.autoConnect = v; await p.saveSettings(); }));
			new Setting(containerEl)
				.setName(p.t('connectToggle'))
				.addButton(b => b.setButtonText(p.connected ? p.t('disconnect') : p.t('connect')).onClick(() => {
					if (p.connected) p.disconnect(true); else p.connect(true);
					this.display();
				}));
		}

		// ── plan (cards) ───────────────────────────────────────
		h3(p.t('planSection'));
		const cards = containerEl.createDiv({ cls: 'unison-cards' });

		const free = cards.createDiv({ cls: 'unison-card' + (p.roomPlan !== 'pro' ? ' is-active' : '') });
		free.createDiv({ cls: 'unison-card-title', text: p.t('planFree') });
		free.createDiv({ cls: 'unison-card-price', text: '$0' });
		free.createDiv({ cls: 'unison-card-desc', text: p.t('planFreeDesc') });
		if (p.roomPlan !== 'pro') free.createSpan({ cls: 'unison-card-badge', text: p.t('planCurrentBadge') });

		const pro = cards.createDiv({ cls: 'unison-card unison-card-pro' + (p.roomPlan === 'pro' ? ' is-active' : '') });
		pro.createDiv({ cls: 'unison-card-title', text: p.t('planPro') });
		const price = pro.createDiv({ cls: 'unison-card-price' });
		price.createSpan({ text: '$3' });
		price.createSpan({ cls: 'unison-card-price-sub', text: ' ' + p.t('planPerMonth') });
		pro.createDiv({ cls: 'unison-card-desc', text: p.t('planProDesc') });
		if (p.roomPlan === 'pro') pro.createSpan({ cls: 'unison-card-badge', text: p.t('planCurrentBadge') });
		const buy = pro.createEl('button', { cls: 'unison-btn unison-card-btn is-soon', text: p.t('planSoon') });
		buy.disabled = true;
		buy.setAttribute('title', p.t('planSoon'));
		const lic = pro.createEl('input', { cls: 'unison-card-input', type: 'text', placeholder: 'UNISON-...' });
		lic.value = p.settings.license || '';
		const applyLic = async () => {
			p.settings.license = (lic.value || '').trim();
			await p.saveSettings();
			if (p.connected) { p.disconnect(true); p.connect(true); }
		};
		lic.onchange = applyLic;
		lic.onblur = applyLic;

		// ── profile ────────────────────────────────────────────
		h3(p.t('profileSection'));
		new Setting(containerEl)
			.setName(p.t('name'))
			.setDesc(p.t('nameDesc'))
			.addText(t => t
				.setPlaceholder(randomName())
				.setValue(p.settings.user || '')
				.onChange(async v => {
					p.settings.user = (v || '').trim() || randomName();
					p.onProfileChanged();
					await p.saveSettings();
				}));
		new Setting(containerEl)
			.setName(p.t('color'))
			.setDesc(p.t('colorDesc'))
			.addColorPicker(c => c
				.setValue(normalizeHex(p.settings.userColor) || normalizeHex(colorFor(p.settings.user)) || '#2196f3')
				.onChange(async v => {
					p.settings.userColor = normalizeHex(v) || v;
					p.onProfileChanged();
					await p.saveSettings();
				}));

		// ── sync ───────────────────────────────────────────────
		h3(p.t('syncSection'));
		const scopeDesc = (p.settings.scopeMode === 'folders')
			? p.t('scopeFolders', (p.settings.syncFolders || []).length)
			: p.t('scopeAll');
		new Setting(containerEl)
			.setName(p.t('scope'))
			.setDesc(scopeDesc)
			.addButton(b => b.setButtonText(p.t('scopeChange')).onClick(() => new ScopeModal(this.app, p).open()));
		new Setting(containerEl)
			.setName(p.t('whatToSync'))
			.addDropdown(d => d
				.addOption('all', p.t('allFiles'))
				.addOption('text', p.t('textOnly'))
				.setValue(p.settings.syncMode || 'all')
				.onChange(async v => { p.settings.syncMode = v; await p.saveSettings(); p.requestFullSync(); }));

		// ── updates ────────────────────────────────────────────
		h3(p.t('updateSection'));
		new Setting(containerEl)
			.setName(p.t('updateName'))
			.setDesc(p.t('updateDesc'))
			.addButton(b => b.setButtonText(p.t('checkUpdate')).onClick(() => p.checkForUpdate(true)));

		// ── advanced ───────────────────────────────────────────
		const adv = containerEl.createEl('details', { cls: 'unison-guide' });
		adv.createEl('summary', { text: p.t('advanced') });
		const advBody = adv.createDiv({ cls: 'unison-guide-body' });

		new Setting(advBody)
			.setName(p.t('langLabel'))
			.setDesc(p.t('langDesc'))
			.addDropdown(d => d
				.addOption('', 'Auto')
				.addOption('en', 'English')
				.addOption('ru', 'Русский')
				.setValue(p.settings.lang || '')
				.onChange(async v => { p.settings.lang = v; await p.saveSettings(); this.display(); p.refreshPresence(); }));

		// ── guide: host your own server ─────────────────────────
		const det = advBody.createEl('details', { cls: 'unison-guide' });
		det.createEl('summary', { text: p.t('guideSummary') });
		const body = det.createDiv({ cls: 'unison-guide-body' });
		body.createEl('p', { text: p.t('guideHint') });
		const pre = body.createEl('pre', { cls: 'unison-status-pre' });
		pre.setText([
			'# 1. On the server (Ubuntu/Debian), Node.js 18+',
			'apt-get install -y nodejs git',
			'',
			'# 2. Copy server.js (see the GitHub repo) and run it',
			'mkdir -p /opt/unison && cd /opt/unison',
			'PORT=3000 DATA_DIR=/opt/unison/data node server.js',
			'',
			'# 3. Open the port (ufw example)',
			'ufw allow 3000/tcp',
			'',
			'# 4. In the plugin settings enter:',
			'#   Server: ws://your-server-ip:3000',
			'#   Room:   any shared name',
		].join('\n'));
		body.createEl('p', { cls: 'unison-settings-hint', text: p.t('guideFooter') });
	}
}

class HistoryModal extends Modal {
	constructor(app, plugin, path) {
		super(app);
		this.plugin = plugin;
		this.path = path;
		this.versions = null;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('unison-history');
		contentEl.createEl('h3', { text: this.plugin.t('historyTitle', this.path) });
		this.listEl = contentEl.createDiv({ text: this.plugin.t('historyLoading') });
		this.plugin.send({ type: 'history-list', path: this.path, clientId: this.plugin.clientId });
	}
	renderVersions(versions) {
		this.versions = versions || [];
		this.listEl.empty();
		if (!this.versions.length) {
			this.listEl.setText(this.plugin.t('historyEmpty'));
			return;
		}
		for (const v of this.versions.slice().reverse()) {
			const row = this.listEl.createDiv({ cls: 'unison-hist-row' });
			const dt = new Date(v.mtime).toLocaleString();
			row.createDiv({ cls: 'unison-hist-meta', text: `v${v.version} · ${dt} · ${v.user || '?'} · ${String(v.hash || '').slice(0, 7)}` });
			const btn = row.createEl('button', { text: this.plugin.t('restore') });
			btn.onclick = () => {
				this.plugin.restoreHistoryVersion(this.path, v.version);
				this.close();
			};
		}
	}
	onClose() {
		if (this.plugin.historyModal === this) this.plugin.historyModal = null;
		const { contentEl } = this;
		contentEl.empty();
	}
}

class LogModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('unison-history');
		contentEl.createEl('h3', { text: this.plugin.t('logTitle') });
		contentEl.createEl('pre', { cls: 'unison-status-pre', text: this.plugin.syncLog.slice(-40).join('\n') });
	}
	onClose() { this.contentEl.empty(); }
}

module.exports = class UnisonPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if (!this.settings.user || this.settings.user === 'User-1') {
			this.settings.user = randomName();
			await this.saveData(this.settings);
			setTimeout(() => new Notice(`Unison: your name is "${this.settings.user}". Change it in settings to your own (unique in the room).`, 8000), 3000);
		}
		if (!this.settings.syncMode) this.settings.syncMode = 'all'; // v1.2: full vault by default
		if (this.settings.excludePatterns === undefined) this.settings.excludePatterns = DEFAULT_SETTINGS.excludePatterns;
		if (this.settings.showRemoteLines === undefined) this.settings.showRemoteLines = true;
		if (!Array.isArray(this.settings.syncFolders)) this.settings.syncFolders = [];
		if (!this.settings.scopeMode) this.settings.scopeMode = 'all';
		if (this.settings.updateUrl === undefined) this.settings.updateUrl = '';
		if (this.settings.apiKey === undefined) this.settings.apiKey = '';
		if (!this.settings.serverMode) {
			this.settings.serverMode = (this.settings.serverUrl && this.settings.serverUrl !== OFFICIAL_SERVER) ? 'custom' : 'hosted';
		}
		// migrate: .obsidian used to be excluded via excludePatterns
		if (this.settings.excludePatterns && this.settings.excludePatterns.includes('.obsidian')) {
			this.settings.excludePatterns = this.settings.excludePatterns
				.split(',').map(s => s.trim()).filter(s => s && s !== '.obsidian/' && s !== '.obsidian').join(', ');
		}
		await this.saveData(this.settings);

		this.clientId = genId();
		this.color = this.settings.userColor || colorFor(this.settings.user);
		this.ws = null;
		this.connected = false;
		this.shouldReconnect = false;
		this.reconnectTimer = null;
		this.reconnectDelay = 1000;
		this.lastError = '';
		this.lastMsgAt = 0;
		this.didInitialSync = false;
		this._fullSyncPending = false;
		this.roomLimit = 5;
		this.roomPlan = 'free';
		this._createPending = false;
		this.syncBusy = false;
		this.syncProgress = null; // {done, total} during first sync
		this.lastSyncAt = 0;
		this.pendingCount = 0;
		this.nameClash = null;
		this._clashWarned = false;
		this._panelOpened = false;
		this.myCursor = { path: '', line: 0, ch: 0 };

		this.remoteUsers = new Map();
		this.remoteCursors = new Map();
		this.suppressed = new Set();
		this.lastRemoteHash = new Map();
		this.lastSentHash = new Map();
		this.knownServer = new Map();
		this.lastSentAt = new Map();   // path -> ts of our last outgoing push (echo guard)
		this.offlineDirty = new Set();
		this.debounceTimers = new Map();
		this.syncLog = [];
		this._toastAt = new Map();
		this._hlAt = 0; // last highlight pass (throttle)
		this._hlTimer = null; // deferred highlight pass
		this._flashAt = 0; // last status flash (throttle)
		this._flashTimer = null;
		this._navObs = null; // file tree observer
		this.lastLocalEditAt = 0;
		this._applyingRemote = 0;
		this._remoteAppliedAt = 0;
		this.historyModal = null;
		this.mergeQueue = new Map(); // path -> {base, label, cursorLine} for offline/join merges
		this.baseContent = new Map(); // path -> last mutually-synced text (for three-way merge, ≤256KB)
		this._skipLogged = new Set(); // oversized paths logged once per session
		this._presenceTimer = null;
		this.statusEl = null;
		this.presenceView = null;
		this.lastCursorSent = 0;
		this.lastCursorKey = '';
		this.latency = 0;       // ping RTT, ms
		this._updating = false;
		this._targetVersion = '';
		this._pendingReload = false;
		this._updateNotified = '';
		this._installedVersion = '';

		this.addSettingTab(new UnisonSettingTab(this.app, this));
		this.registerView(VIEW_TYPE_PRESENCE, leaf => new PresenceView(leaf, this));

		this.statusEl = this.addStatusBarItem();
		this.updateStatus('○ ' + this.t('statusOff'));

		this.addCommand({ id: 'unison-connect', name: 'Connect', callback: () => this.connect(true) });
		this.addCommand({ id: 'unison-disconnect', name: 'Disconnect', callback: () => this.disconnect() });
		this.addCommand({ id: 'unison-sync-now', name: 'Sync everything now', callback: () => this.pushAll() });
		this.addCommand({ id: 'unison-full-sync', name: 'Full sync with server', callback: () => this.requestFullSync() });
		this.addCommand({ id: 'unison-update', name: 'Check for update', callback: () => this.checkForUpdate(true) });
		this.addCommand({ id: 'unison-people', name: 'People in the room', callback: () => this.activatePresence() });
		this.addCommand({ id: 'unison-history', name: 'History of current file', callback: () => this.openHistory() });
		this.addCommand({ id: 'unison-status', name: 'Show log', callback: () => new LogModal(this.app, this).open() });
		this.addCommand({ id: 'unison-revert', name: 'Revert file to server version', callback: () => this.revertToServer() });
		this.addCommand({
			id: 'unison-copy-invite', name: 'Copy invite',
			callback: () => {
				const txt = this.t('inviteText').replace('{server}', this.settings.serverUrl).replace('{room}', this.settings.room);
				navigator.clipboard.writeText(txt).then(() => new Notice(this.t('inviteCopied')), () => new Notice(this.t('inviteFail')));
			}
		});
		this.addCommand({ id: 'unison-quick-connect', name: 'Quick connect from code', callback: () => this.quickConnect() });
		this.addCommand({ id: 'unison-copy-code', name: 'Copy connection code', callback: () => this.copyConnectionCode() });

		this.addRibbonIcon('users', 'Unison', () => this.activatePresence());

		this.registerEvent(this.app.vault.on('modify', f => this.onLocalModify(f)));
		this.registerEvent(this.app.vault.on('create', f => this.onLocalCreate(f)));
		this.registerEvent(this.app.vault.on('delete', f => this.onLocalDelete(f)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.onLocalRename(f, old)));

		this.registerEvent(this.app.workspace.on('editor-change', () => this.onEditorChange()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.sendCursorSoon(); this.scheduleFlags(true); }));

		this.registerInterval(window.setInterval(() => this.heartbeat(), HEARTBEAT_MS));
		this.registerInterval(window.setInterval(() => this.sendCursorSoon(false, true), CURSOR_RESEND_MS));
		this.registerInterval(window.setInterval(() => this.sweepStaleCursors(), 10000));
		this.registerInterval(window.setInterval(() => this.periodicResync(), 90000));
		this.registerInterval(window.setInterval(() => this.periodicSync(), PERIODIC_SYNC_MS));
		this.registerInterval(window.setInterval(() => this.checkForUpdate(false), 6 * 3600 * 1000)); // notify only
		this.setupExplorerObserver();

		// Connect first; the update check only notifies (never auto-installs).
		this.startup();
		this.log('plugin loaded v' + ((this.manifest && this.manifest.version) || '3.0.2'));
	}

	/** Startup: connect, then quietly check whether a newer version exists. */
	async startup() {
		if (this.settings.autoConnect) setTimeout(() => this.connect(), 800);
		// let the connection settle, then notify if an update is available
		setTimeout(() => this.checkForUpdate(false), 8000);
	}

	/**
	 * Periodic two-way sweep (every few seconds): push files whose content
	 * changed on disk, and let the server tell us about anything we are missing.
	 * Catches edits made outside the editor (other apps, sync tools, scripts).
	 */
	async periodicSync() {
		if (!this.connected || this.syncBusy) return;
		if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
		if (this._updating) return;
		if (!this.didInitialSync) return;
		try {
			// outgoing: anything changed since we last sent/observed it
			const local = await this.collectLocalFiles();
			let pushed = 0;
			for (const f of local) {
				const known = this.knownServer.get(f.path);
				const sent = this.lastSentHash.get(f.path);
				const applied = this.lastRemoteHash.get(f.path);
				if (known && known.hash === f.hash) continue;   // server already has this version
				if (sent === f.hash || applied === f.hash) continue;
				const cur = await this.readLocalFile(f.path);
				if (!cur) continue;
				this.lastSentHash.set(f.path, f.hash);
				this.lastSentAt.set(f.path, Date.now());
				this.knownServer.set(f.path, { hash: f.hash, version: (this.knownServer.get(f.path) || {}).version });
				if (cur.encoding === 'utf8' && !(this.baseContent && this.baseContent.has(f.path))) this.setBase(f.path, cur.content);
				const st = await this.app.vault.adapter.stat(f.path).catch(() => null);
				this.send({ type: 'file-update', path: f.path, content: cur.content, encoding: cur.encoding, mtime: st ? st.mtime : Date.now(), clientId: this.clientId, user: this.settings.user });
				pushed++;
				if (pushed % 5 === 0) await new Promise(r => setTimeout(r, 30));
			}
			// incoming: ask the server for its index, reconcile finds the diffs
			this.send({ type: 'list', clientId: this.clientId });
			if (pushed) this.log(`periodic sync: pushed ${pushed}`);
		} catch (e) { /* keep quiet */ }
	}

	onunload() {
		this.shouldReconnect = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this._presenceTimer) clearTimeout(this._presenceTimer);
		if (this._hlTimer) clearTimeout(this._hlTimer);
		if (this._flashTimer) clearTimeout(this._flashTimer);
		if (this._navObs) { try { this._navObs.disconnect(); } catch (e) { /* ignore */ } this._navObs = null; }
		for (const t of this.debounceTimers.values()) clearTimeout(t);
		this.debounceTimers.clear();
		try { if (this.ws && this.ws.readyState === 1) this.ws.close(); } catch (e) { /* ignore */ }
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PRESENCE);
	}

	/** Active language code. */
	lang() {
		if (this.settings.lang === 'en' || this.settings.lang === 'ru') return this.settings.lang;
		try {
			const m = (navigator.language || (navigator.languages && navigator.languages[0]) || 'en');
			return String(m).toLowerCase().startsWith('ru') ? 'ru' : 'en';
		} catch (e) { return 'en'; }
	}

	/** Translate a key; params are passed to the value when it is a function. */
	t(key, ...args) {
		const dict = I18N[this.lang()] || I18N.en;
		const v = (key in dict) ? dict[key] : I18N.en[key];
		return typeof v === 'function' ? v(...args) : (v !== undefined ? v : key);
	}

	async saveSettings() { await this.saveData(this.settings); }

	// ---------- quick connect (share settings via a code) ----------
	/** Encode current connection settings into a short shareable code. */
	makeConnectionCode() {
		const payload = {
			v: 1,
			s: this.settings.serverUrl || '',
			r: this.settings.room || '',
			k: this.settings.apiKey || '',
			t: this.settings.token || '',
		};
		return 'USYNC1-' + b64urlEncode(JSON.stringify(payload));
	}

	/** Decode a code produced by makeConnectionCode (returns null if invalid). */
	parseConnectionCode(code) {
		if (!code) return null;
		let s = String(code).trim();
		s = s.replace(/^USYNC1[-:]/i, '');
		try {
			const obj = JSON.parse(b64urlDecode(s));
			if (!obj || typeof obj !== 'object' || !obj.s) return null;
			return obj;
		} catch (e) { return null; }
	}

	copyConnectionCode() {
		if (!this.settings.serverUrl) { new Notice(this.t('needServerUrl')); return; }
		const code = this.makeConnectionCode();
		navigator.clipboard.writeText(code).then(() => new Notice(this.t('codeCopied'), 5000), () => new Notice(this.t('inviteFail')));
	}

	/** Create a fresh room on the public server and connect to it. */
	async createRoom() {
		const key = 'unison-' + genId() + genId().slice(0, 4);
		this.settings.serverUrl = OFFICIAL_SERVER;
		this.settings.room = key;   // the room key doubles as the room id
		this.settings.token = key;  // and as the server-side room key
		this.settings.apiKey = '';
		this._createPending = true;
		await this.saveSettings();
		this.disconnect(true);
		this.connect(true);
		new Notice(this.t('roomCreated'), 9000);
		this.refreshPresence();
	}

	/** True when the connection is the built-in hosted relay. */
	usesOfficial() {
		return this.settings.serverUrl === OFFICIAL_SERVER;
	}

	/** Ask the user for a code, apply it and connect. */
	quickConnect(code) {
		if (code) { this.applyConnectionCode(code); return; }
		new QuickConnectModal(this.app, this).open();
	}

	applyConnectionCode(code) {
		const obj = this.parseConnectionCode(code);
		if (!obj) { new Notice(this.t('codeInvalid'), 6000); return false; }
		if (obj.s) this.settings.serverUrl = obj.s;
		if (obj.r) this.settings.room = obj.r;
		if (typeof obj.k === 'string') this.settings.apiKey = obj.k;
		if (typeof obj.t === 'string') this.settings.token = obj.t;
		this.saveSettings();
		this.disconnect(true);
		this.connect(true);
		new Notice(this.t('codeApplied'), 5000);
		return true;
	}

	/** Recompute our color (manual pick or auto from name) and tell the room. */
	applyUserColor() {
		this.color = this.settings.userColor || colorFor(this.settings.user);
		this.refreshPresence();
		if (this.connected) {
			// broadcast the new color right away (cursor carries it)
			this.send({ type: 'cursor', path: (this.myCursor && this.myCursor.path) || '', line: (this.myCursor && this.myCursor.line) || 0, ch: (this.myCursor && this.myCursor.ch) || 0, user: this.settings.user, clientId: this.clientId, color: this.color });
		}
	}

	/** Name or color changed in settings: recompute color and tell the room. */
	onProfileChanged() {
		this.applyUserColor();
		this.checkNameClash();
	}

	log(msg) {
		const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
		this.syncLog.push(line);
		if (this.syncLog.length > 60) this.syncLog.shift();
		this.refreshPresence();
		console.log('[unison]', msg);
	}
	toast(key, msg, cooldownMs, dur) {
		if (!this.settings.showNotices) return;
		const now = Date.now();
		if (now - (this._toastAt.get(key) || 0) < (cooldownMs || 10000)) return;
		this._toastAt.set(key, now);
		new Notice(msg, dur || 3500);
	}
	updateStatus(text) { if (this.statusEl) this.statusEl.setText(text); }
	updateCountStatus() {
		if (this.syncProgress) {
			this.updateStatus('⇄ ' + this.t('syncProgress', this.syncProgress.done, this.syncProgress.total));
			return;
		}
		if (!this.connected) { this.updateStatus('○ ' + this.t('statusOff')); return; }
		let s = '● ' + this.t('statusConnected', this.remoteUsers.size + 1);
		if (this.latency > 0) s += ` · ${this.latency}ms`;
		this.updateStatus(s);
	}
	syncStateText() {
		if (this.syncBusy && this.syncProgress) return this.t('syncBusy', this.syncProgress.done, this.syncProgress.total);
		if (!this.lastSyncAt) return this.t('stateIdle');
		const ago = Math.max(0, Math.round((Date.now() - this.lastSyncAt) / 1000));
		const when = ago < 5 ? this.t('stateJustNow') : ago < 60 ? this.t('stateSecAgo', ago) : this.t('stateMinAgo', Math.floor(ago / 60));
		const pend = this.pendingCount ? this.t('pending', this.pendingCount) : '';
		return this.t('stateOk', when) + pend;
	}
	refreshPresence() {
		if (this._presenceTimer) return;
		this._presenceTimer = setTimeout(() => {
			this._presenceTimer = null;
			// never rebuild the sidebar while the user works a control inside it
			try {
				const el = document.activeElement;
				const view = this.presenceView;
				if (el && view && view.containerEl && view.containerEl.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
					this.refreshPresence();
					return;
				}
			} catch (e) { /* ignore */ }
			if (this.presenceView) this.presenceView.render();
			this.updateCountStatus();
			this.refreshExplorerBadges();
		}, 250);
	}

	/** Dots with initials on files being edited by others, right in the file tree. */
	refreshExplorerBadges() {
		try {
			document.querySelectorAll('.unison-explorer-dot').forEach(e => e.remove());
			if (!this.connected) return;
			const byPath = new Map();
			for (const u of this.remoteUsers.values()) {
				if (!u.path) continue;
				if (!byPath.has(u.path)) byPath.set(u.path, []);
				byPath.get(u.path).push(u);
			}
			for (const [p, users] of byPath) {
				let el = null;
				try { el = document.querySelector(`.nav-file-title[data-path="${CSS.escape(p)}"]`); } catch (e) { continue; }
				if (!el) continue;
				const dot = document.createElement('span');
				dot.className = 'unison-explorer-dot' + (users.some(x => x.typing) ? ' typing' : '');
				dot.textContent = users.length === 1 ? initials(users[0].user) : String(users.length);
				dot.style.background = users[0].color || colorFor(users[0].user);
				dot.title = users.map(x => x.user + (x.typing ? ' (печатает…)' : '')).join(', ');
				el.appendChild(dot);
			}
		} catch (e) { /* non-fatal */ }
	}

	/** Re-apply tree badges when Obsidian re-renders the file tree. */
	setupExplorerObserver() {
		try {
			if (this._navObs) return;
			const nav = document.querySelector('.nav-files-container');
			if (!nav || typeof MutationObserver === 'undefined') return;
			this._navObs = new MutationObserver(() => this.refreshPresence());
			this._navObs.observe(nav, { childList: true, subtree: true });
		} catch (e) { /* ignore */ }
	}

	/** Brief status flash for remote activity (throttled, no toasts). */
	flashStatus(text) {
		const now = Date.now();
		if (now - this._flashAt < 5000) return;
		this._flashAt = now;
		this.updateStatus(text);
		if (this._flashTimer) clearTimeout(this._flashTimer);
		this._flashTimer = setTimeout(() => { this._flashTimer = null; this.updateCountStatus(); }, 1600);
	}

	async activatePresence() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PRESENCE);
		if (leaves.length) { this.app.workspace.revealLeaf(leaves[0]); return; }
		const leaf = this.app.workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_PRESENCE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	// ---------- file filters ----------
	excludeList() {
		return (this.settings.excludePatterns || '').split(',').map(s => s.trim()).filter(Boolean);
	}
	isExcluded(path) {
		for (const pat of this.excludeList()) {
			if (!pat) continue;
			if (pat.endsWith('/')) { if (path.startsWith(pat)) return true; }
			else if (path === pat || path.includes(pat)) return true;
		}
		return false;
	}
	/** Folder scope: whole vault, or only the selected folders (and their subtrees). */
	inScope(path) {
		if ((this.settings.scopeMode || 'all') !== 'folders') return true;
		const list = this.settings.syncFolders || [];
		if (!list.length) return true; // nothing picked → don't lock the user out
		for (const folder of list) {
			if (!folder) continue;
			if (path === folder) return true;
			if (path.startsWith(folder + '/')) return true;
		}
		return false;
	}
	isSyncablePath(path) {
		const p = sanitizePath(path);
		if (!p) return false;
		if (p.startsWith('.obsidian/') || p === '.obsidian') return false; // config never syncs
		if (!this.inScope(p)) return false;
		if (this.isExcluded(p)) return false;
		if ((this.settings.syncMode || 'all') === 'text' && !isTextPath(p)) return false;
		return true;
	}
	/** All folders in the vault (for the scope picker). */
	listFolders() {
		const out = [];
		try {
			const root = this.app.vault.getRoot ? this.app.vault.getRoot() : null;
			const walk = (folder) => {
				for (const child of (folder && folder.children) || []) {
					if (child.children) {
						out.push(child.path);
						walk(child);
					}
				}
			};
			if (root) walk(root);
		} catch (e) { /* ignore */ }
		return out.sort((a, b) => a.localeCompare(b));
	}
	isSyncable(file) {
		if (!file || !file.path || file.children) return false;
		return this.isSyncablePath(file.path);
	}

	// ---------- local IO (text + binary) ----------
	/** @returns {Promise<{content:string, encoding:'utf8'|'base64'}|null>} */
	async readLocalFile(path) {
		const p = sanitizePath(path);
		if (!p) return null;
		const file = this.app.vault.getAbstractFileByPath(p);
		if (!file || file.children) return null;
		try {
			if (file.stat && file.stat.size > MAX_TRANSFER_BYTES) {
				if (!this._skipLogged.has(p)) {
					this._skipLogged.add(p);
					this.log(`skip (>${Math.round(MAX_TRANSFER_BYTES / 1048576)}МБ): ${p}`);
				}
				return null;
			}
			if (isTextPath(p)) {
				return { content: await this.app.vault.read(file), encoding: 'utf8' };
			}
			const buf = await this.app.vault.adapter.readBinary(p);
			if (buf.byteLength > MAX_TRANSFER_BYTES) {
				if (!this._skipLogged.has(p)) { this._skipLogged.add(p); this.log(`skip (too big): ${p}`); }
				return null;
			}
			return { content: b64encode(buf), encoding: 'base64' };
		} catch (e) { return null; }
	}

	async writeLocalFile(path, content, encoding) {
		const p = sanitizePath(path);
		if (!p) return false;
		const slash = p.lastIndexOf('/');
		if (slash > 0) {
			const dir = p.slice(0, slash);
			if (!this.app.vault.getAbstractFileByPath(dir)) {
				await this.app.vault.createFolder(dir).catch(() => {});
			}
		}
		if (encoding === 'base64') {
			await this.app.vault.adapter.writeBinary(p, b64decode(content));
			return true;
		}
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing && !existing.children) await this.app.vault.modify(existing, content);
		else if (!existing) await this.app.vault.create(p, content);
		return true;
	}

	/** Current local content as transmitted string (for equality checks). */
	async localTransmitted(path) {
		const r = await this.readLocalFile(path);
		return r ? r.content : null;
	}

	/** Remember last mutually-synced content (merge base). Capped. */
	setBase(path, content) {
		try {
			if (!this.baseContent) this.baseContent = new Map();
			if (typeof content === 'string' && content.length <= 262144) this.baseContent.set(path, content);
			else this.baseContent.delete(path);
		} catch (e) { /* ignore */ }
	}

	/**
	 * Push remote content into OPEN editors of `path` without losing unsaved typing.
	 * - editor matches pre-apply content → safe replace, cursor preserved;
	 * - editor has private unsaved edits (e.g. a char typed a millisecond ago,
	 *   still in the buffer, not on disk) → three-way merge with the pre-apply
	 *   disk content as base, so a modified line merges IN PLACE instead of
	 *   duplicating. Result is pushed immediately.
	 * This closes the stale-buffer wipe: an old buffer can never overwrite fresh text.
	 */
	syncOpenEditors(path, newContent, oldLocal) {
		let leaves = [];
		try { leaves = this.app.workspace.getLeavesOfType('markdown') || []; } catch (e) { return; }
		let activeView = null;
		try { activeView = this.app.workspace.getActiveViewOfType(MarkdownView); } catch (e) { /* ignore */ }
		for (const leaf of leaves) {
			let v = null;
			try { v = leaf.view; } catch (e) { continue; }
			if (!v || !v.file || v.file.path !== path || !v.editor) continue;
			let ev = null;
			try { if (typeof v.editor.getValue !== 'function') continue; ev = v.editor.getValue(); } catch (e) { continue; }
			if (typeof ev !== 'string' || ev === newContent) continue;
			let cursor = null;
			try { cursor = v.editor.getCursor(); } catch (e) { /* ignore */ }
			const restoreCursor = (text) => {
				if (!cursor) return;
				try {
					const maxLine = Math.max(0, text.split('\n').length - 1);
					v.editor.setCursor({ line: Math.min(cursor.line, maxLine), ch: cursor.ch || 0 });
				} catch (e) { /* ignore */ }
			};
			const setRemote = () => {
				this.beginRemoteApply();
				try { v.editor.setValue(newContent); restoreCursor(newContent); } catch (e) { /* ignore */ }
				finally { this.endRemoteApply(); }
			};
			// Merge is only safe for the editor the user is actually looking at and
			// has just been typing in. Secondary/stale/not-yet-loaded views (two tabs
			// of one file, or a freshly opened editor) must simply take the remote
			// text - merging those is what duplicated lines.
			const isActive = !!activeView && v === activeView;
			const userTyping = isActive && (Date.now() - this.lastLocalEditAt < 10000);
			const notLoaded = ev === '' && typeof newContent === 'string' && newContent !== '';
			if (!userTyping || notLoaded || oldLocal === null || oldLocal === undefined || ev === oldLocal) {
				setRemote();
				continue;
			}
			// genuine unsaved typing in the focused editor → three-way merge, push
			const merged = threeWayMerge(oldLocal, ev, newContent);
			if (merged === newContent) { setRemote(); continue; }
			this.beginRemoteApply();
			try { v.editor.setValue(merged); restoreCursor(merged); } catch (e) { this.endRemoteApply(); continue; }
			this.endRemoteApply();
			const h = fnv1a(merged);
			this.lastSentHash.set(path, h);
			this.lastRemoteHash.set(path, h);
			this.setBase(path, merged);
			this.send({ type: 'file-update', path, content: merged, encoding: 'utf8', mtime: Date.now(), clientId: this.clientId, user: this.settings.user });
			this.log(`editor-merge ${path}: three-way with unsaved buffer, pushed`);
		}
	}

	// Self-hosting: run server/server.js on a machine (see docs/server-setup.md).

	// ---------- connection ----------
	connect(manual) {
		if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
		const url = (this.settings.serverUrl || '').trim();
		if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
			// stay silent on auto-connect before the server is configured
			if (manual) new Notice(this.t('needServerUrl'));
			this.updateStatus('○ ' + this.t('statusOff'));
			return;
		}
		if (!this.settings.user) this.settings.user = randomName();
		this.shouldReconnect = true;
		this.lastError = '';
		this.updateStatus('◌ ' + this.t('noticeConnecting'));

		const epoch = (this._connEpoch = (this._connEpoch || 0) + 1);
		this._openedAt = 0;
		let ws;
		try { ws = new WebSocket(url); } catch (e) { this.onConnError(String(e)); return; }
		this.ws = ws;

		ws.onopen = async () => {
			if (this._connEpoch !== epoch || this.ws !== ws) { try { ws.close(); } catch (e) {} return; }
			this.connected = true;
			this._openedAt = Date.now();
			this.reconnectDelay = 1000;
			this.lastMsgAt = Date.now();
			this.updateCountStatus();
			this.log('connected');
			try {
				const files = await this.collectLocalFiles();
				if (this._connEpoch !== epoch || this.ws !== ws) return; // superseded during read
				this.send({ type: 'hello', room: this.settings.room, user: this.settings.user, clientId: this.clientId, color: this.color, token: this.settings.token || '', apiKey: this.settings.apiKey || '', license: this.settings.license || '', create: this._createPending === true, files, device: this.deviceId() });
				this._createPending = false;
			} catch (e) { /* ignore */ }
		};
		ws.onmessage = ev => {
			if (this._connEpoch !== epoch || this.ws !== ws) return; // stale socket
			this.lastMsgAt = Date.now();
			// a healthy exchange means the link is good -> reset backoff
			if (this.reconnectDelay > 1000 && this.connected && Date.now() - this._openedAt > 3000) this.reconnectDelay = 1000;
			let msg;
			try { msg = JSON.parse(ev.data); } catch (e) { return; }
			this.handleMessage(msg).catch(e => console.error('[unison] handle error', e));
		};
		ws.onerror = () => { /* onclose will follow */ };
		ws.onclose = ev => {
			if (this._connEpoch !== epoch || this.ws !== ws) return; // ignore superseded sockets
			const was = this.connected;
			const livedMs = this._openedAt ? Date.now() - this._openedAt : 0;
			this.connected = false;
			this.ws = null;
			this.syncBusy = false;
			this.syncProgress = null;
			this.remoteUsers.clear();
			this.remoteCursors.clear();
			this.updateStatus('○ ' + this.t('statusOff'));
			this.refreshPresence();
			this.refreshExplorerBadges();
			if (was) this.log('disconnected');

			// Fast flap (opened then closed within 2s, no user intent) usually means
			// the server rejected us (bad room/key, or "replaced" by our own new
			// socket) or a suspended mobile app. Do NOT hammer: use a bigger backoff.
			const code = ev && ev.code;
			const flap = livedMs > 0 && livedMs < 2000;
			if (this.shouldReconnect) {
				if (flap) this.reconnectDelay = Math.max(this.reconnectDelay, 5000);
				this.scheduleReconnect();
			}
		};
	}

	/** Stable per-device id so reconnects replace the old socket instead of duplicating. */
	deviceId() {
		if (!this._deviceId) {
			let base = '';
			try { base = (this.app && this.app.vault && this.app.vault.getName && this.app.vault.getName()) || ''; } catch (e) { /* ignore */ }
			this._deviceId = genId() + (base ? '-' + fnv1a(base) : '');
		}
		return this._deviceId;
	}

	disconnect(quiet) {
		this.shouldReconnect = false;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		this.reconnectDelay = 1000;
		try { if (this.ws) this.ws.close(1000, 'user disconnect'); } catch (e) { /* ignore */ }
		this.ws = null;
		this.connected = false;
		this.syncBusy = false;
		this.syncProgress = null;
		this.remoteUsers.clear();
		this.remoteCursors.clear();
		this.updateStatus('○ ' + this.t('statusOff'));
		this.refreshPresence();
		this.refreshExplorerBadges();
		if (!quiet) this.log('disconnected by user');
	}

	scheduleReconnect() {
		if (!this.shouldReconnect || this.reconnectTimer) return;
		const d = Math.min(this.reconnectDelay, RECONNECT_MAX);
		this.updateStatus('◌ ' + this.t('statusReconnect', Math.round(d / 1000)));
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
			this.connect();
		}, d);
	}

	onConnError(msg) {
		this.lastError = msg;
		this.log('connection error: ' + msg);
		this.updateStatus('○ ' + this.t('statusError'));
		if (this.shouldReconnect) this.scheduleReconnect();
	}

	heartbeat() {
		if (!this.connected || !this.ws) return;
		if (Date.now() - this.lastMsgAt > STALE_MS) {
			this.log('stale connection, reconnecting');
			try { this.ws.close(4000, 'stale'); } catch (e) { /* ignore */ }
			return;
		}
		this.pingSentAt = Date.now();
		this.send({ type: 'ping', t: this.pingSentAt });
	}

	send(obj) {
		if (this.ws && this.ws.readyState === 1) {
			try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
		}
		return false;
	}

	/** Ask the server for the full file index and run a two-way reconcile. */
	requestFullSync() {
		if (!this.connected) { new Notice(this.t('noConnection')); return; }
		if (this.syncBusy) return;
		this._fullSyncPending = true;
		this.send({ type: 'list', clientId: this.clientId });
	}

	/** Quiet background safety net: catch anything missed by live events. */
	periodicResync() {
		if (!this.connected || this.syncBusy || !this.didInitialSync) return;
		if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
		this.send({ type: 'list', clientId: this.clientId });
	}

	/** Force-pull the active file from the server, overwriting local changes. */
	revertToServer() {
		let view = null;
		try { view = this.app.workspace.getActiveViewOfType(MarkdownView); } catch (e) { /* ignore */ }
		if (!view || !view.file) { new Notice('Unison: открой файл'); return; }
		if (!this.connected) { new Notice(this.t('noConnection')); return; }
		const path = view.file.path;
		this.mergeQueue.delete(path);
		this.send({ type: 'file-pull', path, clientId: this.clientId });
		this.log(`revert requested: ${path}`);
	}

	/** Raw GitHub base that hosts plugin updates. */
	effectiveUpdateUrl() {
		return UPDATE_REPO.replace(/\/+$/, '');
	}

	/** Cache-busted raw URL for a plugin file. */
	updateFileUrl(name) {
		return `${this.effectiveUpdateUrl()}/${name}?t=${Date.now()}`;
	}

	updateHeaders() {
		return { 'Cache-Control': 'no-cache' };
	}

	/** Fetch the remote manifest (raw text -> JSON). Returns null on failure. */
	async fetchRemoteManifest() {
		try {
			const r = await requestUrl({ url: this.updateFileUrl('manifest.json'), throw: false, headers: this.updateHeaders() });
			const txt = (r && typeof r.text === 'string') ? r.text : '';
			const j = txt ? JSON.parse(txt) : null;
			if (j && j.version) return j;
		} catch (e) { /* give up */ }
		return null;
	}

	/** Download one plugin file as text. */
	async fetchUpdateFile(name) {
		const r = await requestUrl({ url: this.updateFileUrl(name), throw: false, headers: this.updateHeaders() });
		if (!r || r.status !== 200 || typeof r.text !== 'string') throw new Error('download failed: ' + name);
		return r.text;
	}

	pluginDir() {
		if (this.manifest && this.manifest.dir) return this.manifest.dir;
		return `.obsidian/plugins/${(this.manifest && this.manifest.id) || 'unison'}`;
	}

	/** Self-update: compare with the server's copy and swap files, then reload.
	 *  @returns {Promise<boolean>} true when a new version was downloaded (app will reload) */
	/**
	 * Check for a newer version.
	 *  - manual = true  (button/command): download, install and restart.
	 *  - manual = false (background): only NOTIFY that an update exists, and tell
	 *    the user to open Settings and press the button. Never installs on its own.
	 */
	async checkForUpdate(manual) {
		if (this._updating) return this._pendingReload;
		const base = this.effectiveUpdateUrl();
		if (!base) { if (manual) new Notice(this.t('noticeUpdateUrlEmpty')); return false; }
		try {
			const remote = await this.fetchRemoteManifest();
			if (!remote || !remote.version) throw new Error('bad manifest');
			const cur = this._installedVersion || (this.manifest && this.manifest.version) || '0.0.0';
			if (this.compareVersions(remote.version, cur) <= 0) {
				if (manual) new Notice(this.t('noticeUpToDate', cur));
				this.log(`update check: up to date (${cur})`);
				if (remote.version === cur) { this._targetVersion = cur; this._updateNotified = ''; }
				return false;
			}

			// A newer version exists. Background checks only notify once.
			if (!manual) {
				if (this._updateNotified !== remote.version) {
					this._updateNotified = remote.version;
					new Notice(this.t('noticeUpdateAvailable', remote.version, cur), 10000);
					this.log(`update available: ${cur} -> ${remote.version} (open settings to install)`);
				}
				return false;
			}

			// Manual: download and install.
			if (this._targetVersion === remote.version) {
				new Notice(this.t('noticeLatestDownloaded', remote.version));
				this._pendingReload = true;
				return true;
			}
			this._updating = true;
			this.log(`update: ${cur} -> ${remote.version}, downloading...`);
			const dir = this.pluginDir();
			try { await this.app.vault.adapter.mkdir(dir); } catch (e) { /* exists */ }
			for (const f of ['manifest.json', 'main.js', 'styles.css']) {
				const text = await this.fetchUpdateFile(f);
				await this.app.vault.adapter.write(`${dir}/${f}`, text);
			}
			this._targetVersion = remote.version;
			this._pendingReload = true;
			this._updateNotified = '';
			this._installedVersion = remote.version; // do NOT mutate this.manifest.version
			this._updating = false;
			new Notice(this.t('noticeUpdating', remote.version), 6000);
			setTimeout(() => this.reloadSelf(), 900);
			return true;
		} catch (e) {
			this._updating = false;
			if (manual) new Notice(this.t('noticeUpdateFail'));
			this.log('update check failed: ' + (e && e.message ? e.message : e));
			return false;
		}
	}

	/**
	 * Reload Obsidian itself. Re-enabling the plugin does NOT re-read main.js
	 * (the module stays cached in memory), so a full app reload is the only
	 * reliable way to apply an update - on desktop as well as on mobile.
	 */
	reloadSelf() {
		new Notice(this.t('noticeUpdating', (this.manifest && this.manifest.version) || ''), 6000);
		setTimeout(() => {
			// app:reload is the documented full restart command on desktop & mobile.
			try { if (this.app.commands && this.app.commands.executeCommandById('app:reload')) return; } catch (e) { /* next */ }
			// Electron desktop fallback: force the renderer to reload.
			try { if (this.app.appId && window.electron && window.electron.remote) { window.electron.remote.app.relaunch(); window.electron.remote.app.exit(); return; } } catch (e) { /* next */ }
			try { window.location.reload(); } catch (e2) {
				new Notice(this.t('noticeReload'), 8000);
			}
		}, 1500);
	}

	/** a > b → 1, a < b → -1, equal → 0 */
	compareVersions(a, b) {
		const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
		const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const x = pa[i] || 0, y = pb[i] || 0;
			if (x > y) return 1;
			if (x < y) return -1;
		}
		return 0;
	}

	// ---------- local file index ----------
	async collectLocalFiles() {
		const out = [];
		const files = this.app.vault.getFiles();
		for (const f of files) {
			if (!this.isSyncable(f)) continue;
			try {
				const st = await this.app.vault.adapter.stat(f.path);
				const r = await this.readLocalFile(f.path);
				if (!r) continue; // too big / unreadable
				out.push({ path: f.path, mtime: st ? st.mtime : f.stat.mtime, size: f.stat.size, hash: fnv1a(r.content), encoding: r.encoding });
			} catch (e) { /* skip */ }
		}
		return out;
	}

	// ---------- message handling ----------
	async handleMessage(msg) {
		switch (msg.type) {
			case 'welcome': return this.onWelcome(msg);
			case 'file-list': {
				// Only the very first index (or an explicit "Full sync") is a full
				// reconcile. Periodic list responses are deltas, otherwise every
				// sweep would merge the file against the server while typing.
				const first = !this.didInitialSync || this._fullSyncPending;
				this._fullSyncPending = false;
				return this.reconcile(msg.files || [], first, true);
			}
			case 'user-join': return this.onUserJoin(msg);
			case 'user-leave': return this.onUserLeave(msg);
			case 'presence': return this.onPresence(msg);
			case 'file-update': return this.onRemoteFileUpdate(msg);
			case 'file-delete': return this.onRemoteFileDelete(msg);
			case 'file-rename': return this.onRemoteFileRename(msg);
			case 'file-request': return this.onFileRequest(msg);
			case 'cursor': return this.onRemoteCursor(msg);
			case 'history': return this.onHistory(msg);
			case 'history-file': return this.onHistoryFile(msg);
			case 'error': {
				this.lastError = msg.message || 'server error';
				if (/full/i.test(this.lastError)) new Notice(this.t('roomFull'), 10000);
				this.toast('srv-err', 'Unison: ' + this.lastError, 15000, 5000);
				this.log('server error: ' + this.lastError);
				if (/token|auth|room/i.test(this.lastError)) this.shouldReconnect = false;
				this.refreshPresence();
				return;
			}
			case 'pong': {
				if (msg.t) this.latency = Math.max(0, Date.now() - msg.t);
				this.updateCountStatus();
				return;
			}
		}
	}

	setUsers(list) {
		this.remoteUsers.clear();
		for (const u of (list || [])) {
			if (!u || u.clientId === this.clientId) continue;
			const prev = this.remoteCursors.get(u.clientId);
			this.remoteUsers.set(u.clientId, { user: u.user, clientId: u.clientId, color: u.color || colorFor(u.user), path: u.path || '', line: u.line || 0, sel: u.sel || null, typing: prev ? !!prev.typing : false });
		}
		this.updateCountStatus();
		this.checkNameClash();
		this.refreshPresence();
	}

	checkNameClash() {
		const counts = new Map();
		counts.set(this.settings.user, [this.clientId]);
		for (const u of this.remoteUsers.values()) {
			if (!counts.has(u.user)) counts.set(u.user, []);
			counts.get(u.user).push(u.clientId);
		}
		let clash = null;
		for (const [name, ids] of counts) if (ids.length > 1) { clash = name; break; }
		this.nameClash = clash;
		if (clash && !this._clashWarned) {
			this._clashWarned = true;
			new Notice(this.t('nameClash', clash), 8000);
			this.log(`name clash: ${clash}`);
		}
		if (!clash) this._clashWarned = false;
	}

	onUserJoin(msg) {
		if (!msg || msg.clientId === this.clientId) return;
		this.remoteUsers.set(msg.clientId, { user: msg.user, clientId: msg.clientId, color: msg.color || colorFor(msg.user), path: '', line: 0, typing: false });
		this.updateCountStatus();
		this.log(`join: ${msg.user}`);
		this.checkNameClash();
		this.refreshPresence();
	}

	onUserLeave(msg) {
		if (!msg) return;
		const u = this.remoteUsers.get(msg.clientId);
		this.remoteUsers.delete(msg.clientId);
		this.remoteCursors.delete(msg.clientId);
		this.scheduleFlags(true);
		this.updateCountStatus();
		if (u) this.log(`leave: ${u.user}`);
		this.checkNameClash();
		this.refreshPresence();
	}

	onPresence(msg) {
		this.setUsers(msg.users);
		this.log(`presence: ${this.remoteUsers.size} online`);
	}

	async onWelcome(msg) {
		this.setUsers(msg.users);
		if (msg.limit) this.roomLimit = msg.limit;
		if (msg.plan) this.roomPlan = msg.plan;
		this.log(`welcome: ${this.remoteUsers.size} online, ${(msg.files || []).length} files on server`);
		// auto-open people panel on the right (once per session)
		if (!this._panelOpened) {
			this._panelOpened = true;
			try { await this.activatePresence(); } catch (e) { /* ignore */ }
		}
		const first = !this.didInitialSync;
		this.didInitialSync = true;
		await this.reconcile(msg.files || [], first);
	}

	async reconcile(serverFiles, first, quiet) {
		const serverByPath = new Map();
		for (const f of serverFiles) {
			const p = sanitizePath(f.path);
			if (p && this.isSyncablePath(p)) serverByPath.set(p, f);
		}
		let pulls = 0, pushes = 0;
		this.syncBusy = true;
		const pace = () => new Promise(r => setTimeout(r, 40));

		if (first) {
			const localByPath = new Map();
			for (const f of await this.collectLocalFiles()) localByPath.set(f.path, f);
			const total = serverByPath.size + localByPath.size;
			let done = 0;
			this.syncProgress = { done: 0, total };
			for (const [path, sf] of serverByPath) {
				this.knownServer.set(path, { hash: sf.hash, version: sf.version });
				if (!localByPath.has(path)) {
					this.send({ type: 'file-pull', path, clientId: this.clientId });
					pulls++;
				}
				done++; this.syncProgress = { done, total }; this.updateCountStatus();
			}
			for (const [path, lf] of localByPath) {
				const sf = serverByPath.get(path);
				if (!sf) {
					await this.pushFile(path);
					pushes++;
					await pace();
				} else if (sf.hash && lf.hash && sf.hash !== lf.hash) {
					// Newcomer must NEVER clobber server content (e.g. same default
					// name "Без названия.md"): pull server version, our local-only
					// lines get appended at the end (applyOfflineMerge).
					if (lf.encoding === 'utf8') {
						const snap = await this.readLocalFile(path);
						if (snap && snap.encoding === 'utf8' && snap.content) {
							this.mergeQueue.set(path, { base: snap.content, label: 'при входе', cursorLine: this.cursorLineFor(path) });
						}
					}
					this.send({ type: 'file-pull', path, clientId: this.clientId });
					pulls++;
				}
				done++; this.syncProgress = { done, total }; this.updateCountStatus();
			}
			this.syncProgress = null;
			await this.pruneMissingOnServer(serverFiles);
		} else {
			for (const [path, sf] of serverByPath) {
				const k = this.knownServer.get(path);
				if (k && k.hash === sf.hash) continue;
				if (this.lastSentHash.get(path) === sf.hash) {
					this.knownServer.set(path, { hash: sf.hash, version: sf.version });
					continue;
				}
				this.send({ type: 'file-pull', path, clientId: this.clientId });
				pulls++;
			}
			for (const path of [...this.offlineDirty]) {
				const sf = serverByPath.get(path);
				if (!sf) {
					await this.pushFile(path);
					pushes++;
					await pace();
					this.offlineDirty.delete(path);
				} else {
					const k = this.knownServer.get(path);
					if (k && k.hash === sf.hash) {
						await this.pushFile(path);
						pushes++;
						await pace();
						this.offlineDirty.delete(path);
					} else if (!isTextPath(path)) {
						// binary conflict: merge impossible → mtime wins
						let lMt = 0;
						try { const st = await this.app.vault.adapter.stat(path); lMt = st ? st.mtime : 0; } catch (e) { this.offlineDirty.delete(path); continue; }
						if (lMt > (sf.mtime || 0) + 2000) { await this.pushFile(path); pushes++; await pace(); this.toast('conflict:' + path, this.t('conflictNewer', path), 60000); }
						else { this.send({ type: 'file-pull', path, clientId: this.clientId }); pulls++; this.toast('conflict:' + path, this.t('conflictServerNewer', path), 60000); }
						this.offlineDirty.delete(path);
					} else {
						// text changed BOTH offline and on server → server text stays,
						// our offline-added lines get inserted at our last cursor place
						const snap = await this.readLocalFile(path);
						if (!snap || snap.encoding !== 'utf8') { this.offlineDirty.delete(path); continue; }
						this.mergeQueue.set(path, { base: snap.content, label: 'офлайн', cursorLine: this.cursorLineFor(path) });
						this.send({ type: 'file-pull', path, clientId: this.clientId });
						pulls++;
						this.offlineDirty.delete(path);
					}
				}
			}
		}

		this.syncBusy = false;
		this.lastSyncAt = Date.now();
		this.pendingCount = this.offlineDirty.size;
		this.updateCountStatus();
		const kind = first ? 'full' : 'delta';
		if (pulls || pushes) this.log(`reconcile (${kind}): pull=${pulls} push=${pushes}`);
		else if (!quiet) this.log(`reconcile (${kind}): already in sync`);
		if (pulls || pushes) this.refreshPresence();
	}

	async pushFile(path) {
		const p = sanitizePath(path);
		if (!p || !this.isSyncablePath(p)) return;
		const r = await this.readLocalFile(p);
		if (!r) return; // too big / unreadable
		const h = fnv1a(r.content);
		this.lastSentHash.set(p, h);
		// The pushed content IS what the server will now hold, so remember it as
		// the known-server state too. Without this the very first edit right
		// after connect was treated as a remote change and rolled back.
		this.knownServer.set(p, { hash: h, version: (this.knownServer.get(p) || {}).version });
		this.lastSentAt.set(p, Date.now());
		if (r.encoding === 'utf8' && !(this.baseContent && this.baseContent.has(p))) this.setBase(p, r.content);
		let mtime = Date.now();
		try { const st = await this.app.vault.adapter.stat(p); if (st) mtime = st.mtime; } catch (e) { /* ignore */ }
		this.send({ type: 'file-update', path: p, content: r.content, encoding: r.encoding, mtime, clientId: this.clientId, user: this.settings.user });
	}

	async pushAll() {
		if (!this.connected) { new Notice(this.t('noConnection')); return; }
		const files = await this.collectLocalFiles();
		let n = 0;
		for (const f of files) {
			await this.pushFile(f.path);
			n++;
			if (n % 5 === 0) {
				this.syncProgress = { done: n, total: files.length };
				this.updateCountStatus();
			}
			await new Promise(r => setTimeout(r, 40));
		}
		this.syncProgress = null;
		this.updateCountStatus();
		new Notice(`Unison: отправлено файлов: ${n}`);
		this.log(`pushAll: ${n} files`);
	}

	// ---------- local vault events → server ----------
	onLocalModify(file) {
		if (!file || !this.isSyncable(file)) return;
		const path = file.path;
		if (this.suppressed.has(path)) return;
		if (!this.connected) { this.offlineDirty.add(path); this.pendingCount = this.offlineDirty.size; this.refreshPresence(); return; }
		if (this.debounceTimers.has(path)) clearTimeout(this.debounceTimers.get(path));
		this.debounceTimers.set(path, setTimeout(async () => {
			this.debounceTimers.delete(path);
			if (this.suppressed.has(path)) return;
			if (!this.connected) { this.offlineDirty.add(path); return; }
			const r = await this.readLocalFile(path);
			if (!r) return;
			const h = fnv1a(r.content);
			if (this.lastSentHash.get(path) === h) return;              // already sent
			const k = this.knownServer.get(path);
			if (k && k.hash === h) return;                              // server already has it
			if (this.lastRemoteHash.get(path) === h) return;            // matches what we applied
			this.lastSentHash.set(path, h);
			this.lastSentAt.set(path, Date.now());
			this.knownServer.set(path, { hash: h, version: (this.knownServer.get(path) || {}).version });
			if (r.encoding === 'utf8' && !(this.baseContent && this.baseContent.has(path))) this.setBase(path, r.content);
			let mtime = Date.now();
			try { const st = await this.app.vault.adapter.stat(path); if (st) mtime = st.mtime; } catch (e) { /* ignore */ }
			this.send({ type: 'file-update', path, content: r.content, encoding: r.encoding, mtime, clientId: this.clientId, user: this.settings.user });
		}, DEBOUNCE_MS));
	}

	async onLocalCreate(file) {
		if (!file || !this.isSyncable(file)) return;
		if (this.suppressed.has(file.path)) return;
		if (!this.connected) { this.offlineDirty.add(file.path); this.pendingCount = this.offlineDirty.size; this.refreshPresence(); return; }
		setTimeout(async () => {
			if (!this.connected || this.suppressed.has(file.path)) return;
			const p = sanitizePath(file.path);
			// Collision guard: server already has a DIFFERENT version we never applied
			// (e.g. same default name "Без названия.md") → merge, never blind-push.
			try {
				const r = await this.readLocalFile(p);
				const k = r ? this.knownServer.get(p) : null;
				if (r && k && k.hash && k.hash !== fnv1a(r.content) && this.lastRemoteHash.get(p) !== k.hash) {
					// Server has a DIFFERENT version we never applied → take server,
					// merge our lines if we have any. Never blind-push.
					if (r.encoding === 'utf8' && r.content) {
						this.mergeQueue.set(p, { base: r.content, label: 'совпадение имён', cursorLine: this.cursorLineFor(p) });
					}
					this.send({ type: 'file-pull', path: p, clientId: this.clientId });
					this.toast('collide:' + p, this.t('nameCollision', p), 20000);
					this.log(`name collision on ${p} → pull server version, not push`);
					return;
				}
			} catch (e) { /* fall through to push */ }
			this.pushFile(file.path);
		}, 600);
	}

	onLocalDelete(file) {
		if (!file || !file.path) return;
		const path = sanitizePath(file.path);
		if (!path || !this.isSyncablePath(path)) return;
		if (this.suppressed.has(path)) return;
		this.lastRemoteHash.delete(path);
		this.lastSentHash.delete(path);
		this.knownServer.delete(path);
		if (this.baseContent) this.baseContent.delete(path);
		if (!this.connected) return;
		this.send({ type: 'file-delete', path, clientId: this.clientId, user: this.settings.user });
		this.log('deleted local → broadcast: ' + path);
	}

	onLocalRename(file, oldPath) {
		if (!file || !file.path) return;
		const newPath = sanitizePath(file.path);
		const old = sanitizePath(oldPath);
		if (!old || !newPath) return;
		if (this.suppressed.has(newPath) || this.suppressed.has(old)) return;
		this.lastRemoteHash.delete(old);
		this.lastSentHash.delete(old);
		this.knownServer.delete(old);
		if (this.baseContent) { this.baseContent.delete(old); this.baseContent.delete(newPath); }
		if (!this.connected) return;
		if (!this.isSyncablePath(newPath) && !this.isSyncablePath(old)) return;
		// The old path no longer exists locally, so onLocalDelete never fires for it.
		// Tell the server to rename (it also migrates its history and disk copy).
		this.send({ type: 'file-rename', oldPath: old, newPath, clientId: this.clientId, user: this.settings.user });
		this.log(`renamed local: ${old} → ${newPath}`);
		setTimeout(() => { if (this.connected) this.pushFile(newPath); }, 800);
	}

	/**
	 * Catch deletions the vault never reported as events (most common case:
	 * a file changed while the plugin/app was not running). Reconcile removes
	 * server-side entries we no longer have locally.
	 */
	async pruneMissingOnServer(serverFiles) {
		if (!this.connected || !Array.isArray(serverFiles)) return 0;
		let removed = 0;
		for (const sf of serverFiles) {
			const p = sanitizePath(sf.path);
			if (!p || !this.isSyncablePath(p)) continue;
			if (this.app.vault.getAbstractFileByPath(p)) continue;        // still here
			if (this.knownServer.has(p) || this.lastRemoteHash.has(p)) continue; // just applied, keep
			if (this.offlineDirty.has(p)) continue;                       // pending push
			this.send({ type: 'file-delete', path: p, clientId: this.clientId, user: this.settings.user });
			this.log('removed on server (gone locally): ' + p);
			removed++;
		}
		return removed;
	}

	// ---------- remote events → vault ----------
	async onRemoteFileUpdate(msg) {
		if (!msg || msg.clientId === this.clientId) return;
		const path = sanitizePath(msg.path);
		if (!path || !this.isSyncablePath(path)) return;
		if (typeof msg.content !== 'string') return;
		if (msg.content.length > MAX_TRANSFER_BYTES * 2 + 1024) { this.log('skip oversized remote file: ' + path); return; }
		// offline-merge: server answered our conflict pull → merge instead of plain apply
		if (this.mergeQueue.has(path)) {
			const q = this.mergeQueue.get(path);
			this.mergeQueue.delete(path);
			const base = q && q.base !== undefined ? q.base : q;
			return this.applyOfflineMerge(path, msg, base, (q && q.label) || 'офлайн', q ? q.cursorLine : undefined);
		}
		const encoding = msg.encoding === 'base64' ? 'base64' : 'utf8';
		const h = fnv1a(msg.content);
		this.knownServer.set(path, { hash: h, version: msg.version });
		// Echo of our own recent push (server relays only to others, but a
		// reconnect/повторная доставка can bounce it back) → just record, don't apply.
		if (msg.clientId === 'server' || msg.clientId === this.clientId) {
			if (this.lastSentHash.get(path) === h || this.lastSentAt.has(path)) {
				this.lastRemoteHash.set(path, h);
				return;
			}
		}
		if (this.lastRemoteHash.get(path) === h) return; // already applied
		const cur = await this.localTransmitted(path);
		if (cur !== null && fnv1a(cur) === h) { this.lastRemoteHash.set(path, h); this.setBase(path, cur); return; } // already equal
		if (cur === null) {
			// new file for us → take as-is
			return this.applyRemoteContent(path, msg.content, encoding, h, msg, null);
		}
		const hL = fnv1a(cur);
		if (hL === this.lastSentHash.get(path) || hL === this.lastRemoteHash.get(path)) {
			// No local divergence (idle, or everything we typed is already on
			// server): take remote as-is. The other side's deletions propagate here.
			return this.applyRemoteContent(path, msg.content, encoding, h, msg, cur);
		}
		if (encoding !== 'utf8') {
			// binary can't merge → last write wins
			return this.applyRemoteContent(path, msg.content, encoding, h, msg, cur);
		}
		// BOTH sides diverged (we're mid-typing too) → three-way merge, never
		// overwrite: untouched regions apply cleanly, same-line typing merges
		// in place instead of duplicating.
		const B0 = this.baseContent ? this.baseContent.get(path) : undefined;
		const merged = (B0 !== undefined && B0 !== null)
			? threeWayMerge(B0, cur, msg.content)
			: mergeUnknownBase(msg.content, cur);
		if (merged === msg.content) {
			return this.applyRemoteContent(path, msg.content, encoding, h, msg, cur);
		}
		const hM = fnv1a(merged);
		this.suppressed.add(path);
		this.lastRemoteHash.set(path, hM);
		this.lastSentHash.set(path, hM);
		this.setBase(path, merged);
		this.knownServer.set(path, { hash: hM, version: msg.version });
		this.offlineDirty.delete(path);
		this.pendingCount = this.offlineDirty.size;
		setTimeout(() => this.suppressed.delete(path), SUPPRESS_MS);
		try {
			this.beginRemoteApply();
			try {
				await this.writeLocalFile(path, merged, 'utf8');
				this.syncOpenEditors(path, merged, cur);
			} finally { this.endRemoteApply(); }
			this.send({ type: 'file-update', path, content: merged, encoding: 'utf8', mtime: Date.now(), clientId: this.clientId, user: this.settings.user });
			this.lastSyncAt = Date.now();
			this.log(`merge-live ${path}: union with local typing, pushed`);
			const base = path.slice(path.lastIndexOf('/') + 1);
			this.flashStatus(`⇄ ${base} ← ${msg.user || ''}`.trim());
		} catch (e) {
			console.error('[unison] live merge failed', path, e);
		}
	}

	/** Plain apply of remote content (no local divergence). Shared by all paths. */
	async applyRemoteContent(path, content, encoding, h, msg, cur) {
		this.suppressed.add(path);
		this.lastRemoteHash.set(path, h);
		this.setBase(path, content);
		this.offlineDirty.delete(path);
		this.pendingCount = this.offlineDirty.size;
		setTimeout(() => this.suppressed.delete(path), SUPPRESS_MS);
		try {
			this.beginRemoteApply();
			try {
				await this.writeLocalFile(path, content, encoding);
				this.syncOpenEditors(path, content, cur);
			} finally { this.endRemoteApply(); }
			this.lastSyncAt = Date.now();
			this.log(`⇄ ${path} ← ${msg.user || 'remote'}`);
			const base = path.slice(path.lastIndexOf('/') + 1);
			this.flashStatus(`⇄ ${base} ← ${msg.user || ''}`.trim());
		} catch (e) {
			console.error('[unison] apply remote update failed', path, e);
		}
	}

	/**
	 * Offline/join merge: server text stays in place, our lines land where they
	 * belong - three-way merge when the synced base is known (edits apply in
	 * place, same-line typing doesn't duplicate), otherwise anchored insert at
	 * our last cursor, otherwise append at end. Nothing is lost, no signature.
	 */
	async applyOfflineMerge(path, msg, base, label, cursorLine) {
		label = label || 'офлайн';
		const encoding = msg.encoding === 'base64' ? 'base64' : 'utf8';
		if (encoding !== 'utf8' || typeof msg.content !== 'string') return; // not mergeable
		const serverText = msg.content;
		let localText = await this.localTransmitted(path);
		if (localText === null) localText = base || '';
		const B = this.baseContent ? this.baseContent.get(path) : undefined;
		let merged, how;
		if (B !== undefined && B !== null) {
			merged = threeWayMerge(B, localText, serverText);
			how = 'three-way';
		} else if (cursorLine !== undefined && cursorLine !== null && cursorLine >= 0) {
			merged = anchoredInsert(serverText, localText, cursorLine);
			how = 'anchor';
		} else {
			merged = mergeUnknownBase(serverText, localText);
			how = 'no-base';
		}
		const h = fnv1a(merged);
		this.suppressed.add(path);
		setTimeout(() => this.suppressed.delete(path), SUPPRESS_MS);
		this.lastRemoteHash.set(path, h);
		this.lastSentHash.set(path, h);
		this.setBase(path, merged);
		this.knownServer.set(path, { hash: h, version: msg.version });
		try {
			this.beginRemoteApply();
			try {
				await this.writeLocalFile(path, merged, 'utf8');
				this.syncOpenEditors(path, merged, localText);
			} finally { this.endRemoteApply(); }
			this.send({ type: 'file-update', path, content: merged, encoding: 'utf8', mtime: Date.now(), clientId: this.clientId, user: this.settings.user });
			this.lastSyncAt = Date.now();
			if (merged !== serverText) {
				this.toast('merge:' + path, this.t('merged', path), 15000);
				this.log(`merge ${path} (${label}, ${how}): diverged, merged`);
			} else {
				this.log(`merge ${path} (${label}): nothing new, took server version`);
			}
			this.refreshPresence();
		} catch (e) {
			console.error('[unison] offline merge failed', path, e);
		}
	}

	async onRemoteFileDelete(msg) {
		if (!msg || msg.clientId === this.clientId) return;
		const path = sanitizePath(msg.path);
		if (!path || !this.isSyncablePath(path)) return;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!f) return;
		this.suppressed.add(path);
		setTimeout(() => this.suppressed.delete(path), SUPPRESS_MS);
		this.lastRemoteHash.delete(path);
		this.lastSentHash.delete(path);
		this.knownServer.delete(path);
		if (this.baseContent) this.baseContent.delete(path);
		try {
			await this.app.vault.delete(f);
			this.toast('del:' + path, this.t('deletedBy', msg.user || '?', path), 10000);
			this.log(`deleted remote: ${path} by ${msg.user}`);
		} catch (e) { /* ignore */ }
	}

	async onRemoteFileRename(msg) {
		if (!msg || msg.clientId === this.clientId) return;
		const oldPath = sanitizePath(msg.oldPath);
		const newPath = sanitizePath(msg.newPath);
		if (!oldPath || !newPath) return;
		const f = this.app.vault.getAbstractFileByPath(oldPath);
		if (!f) return;
		this.suppressed.add(oldPath); this.suppressed.add(newPath);
		setTimeout(() => { this.suppressed.delete(oldPath); this.suppressed.delete(newPath); }, SUPPRESS_MS);
		// migrate tracking to the new path (local rename event is suppressed, so do it here)
		try {
			for (const m of [this.lastRemoteHash, this.lastSentHash, this.knownServer, this.baseContent]) {
				if (m && m.has(oldPath)) { m.set(newPath, m.get(oldPath)); m.delete(oldPath); }
			}
		} catch (e) { /* ignore */ }
		try {
			const slash = newPath.lastIndexOf('/');
			if (slash > 0) {
				const dir = newPath.slice(0, slash);
				if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
			}
			await this.app.fileManager.renameFile(f, newPath);
			this.toast('ren:' + newPath, this.t('renamedBy', msg.user || '?', oldPath, newPath), 10000);
			this.log(`renamed remote: ${oldPath} → ${newPath}`);
		} catch (e) { /* ignore */ }
	}

	async onFileRequest(msg) {
		if (!msg || !msg.path) return;
		await this.pushFile(msg.path);
	}

	// ---------- file history (server keeps last versions) ----------
	openHistory() {
		let view = null;
		try { view = this.app.workspace.getActiveViewOfType(MarkdownView); } catch (e) { /* ignore */ }
		if (!view || !view.file) { new Notice(this.t('openFileFirst')); return; }
		if (!this.connected) { new Notice(this.t('noConnection')); return; }
		if (this.historyModal) this.historyModal.close();
		this.historyModal = new HistoryModal(this.app, this, view.file.path);
		this.historyModal.open();
	}

	async onHistory(msg) {
		if (!msg || !this.historyModal || this.historyModal.path !== msg.path) return;
		this.historyModal.renderVersions(msg.versions || []);
	}

	async onHistoryFile(msg) {
		if (!msg || typeof msg.content !== 'string') return;
		const path = sanitizePath(msg.path);
		if (!path) return;
		this.suppressed.delete(path); // this is a deliberate local restore → must propagate
		try {
			this.beginRemoteApply();
			try { await this.writeLocalFile(path, msg.content, msg.encoding === 'base64' ? 'base64' : 'utf8'); }
			finally { this.endRemoteApply(); }
			this.toast('restored:' + path, this.t('restored', path, msg.version), 8000);
			this.log(`restored ${path} to v${msg.version}`);
		} catch (e) {
			new Notice(this.t('restoreFail'));
		}
	}

	restoreHistoryVersion(path, version) {
		this.send({ type: 'history-get', path, version, clientId: this.clientId });
	}

	// ---------- cursors / presence ----------
	onEditorChange() {
		// A remote apply rewrites the buffer through setValue, which fires
		// editor-change too. That must not count as *our* typing.
		if (this._applyingRemote > 0 || Date.now() - this._remoteAppliedAt < 500) { this.scheduleFlags(); return; }
		this.lastLocalEditAt = Date.now();
		this.sendCursorSoon();
		this.scheduleFlags();
	}

	beginRemoteApply() { this._applyingRemote = (this._applyingRemote || 0) + 1; }
	endRemoteApply() {
		this._applyingRemote = Math.max(0, (this._applyingRemote || 0) - 1);
		this._remoteAppliedAt = Date.now();
	}

	sendCursorSoon(plain, isResend) {
		const now = Date.now();
		let view = null;
		try { view = this.app.workspace.getActiveViewOfType(MarkdownView); } catch (e) { return; }
		if (!view || !view.editor || !view.file) return;
		let cursor = null;
		try { cursor = view.editor.getCursor(); } catch (e) { return; }
		if (!cursor) return;
		// selection (capped; collapsed → null)
		let sel = null;
		try {
			const s = view.editor.getSelection ? view.editor.getSelection() : null;
			if (s && s.from && s.to && !(s.from.line === s.to.line && s.from.ch === s.to.ch) && Math.abs(s.to.line - s.from.line) <= 2000) {
				sel = { a: { line: s.from.line, ch: s.from.ch }, h: { line: s.to.line, ch: s.to.ch } };
			}
		} catch (e) { /* ignore */ }
		const selKey = sel ? `${sel.a.line}:${sel.a.ch}-${sel.h.line}:${sel.h.ch}` : '';
		const key = `${view.file.path}:${cursor.line}:${cursor.ch}|${selKey}`;
		const changed = key !== this.lastCursorKey;
		// Always track our position - even offline (anchor for offline merge).
		this.lastCursorKey = key;
		this.myCursor = { path: view.file.path, line: cursor.line, ch: cursor.ch };
		this.mySel = sel;
		if (!this.connected || !this.settings.shareCursor) return;
		if (!changed) {
			if (!isResend) return;
			if (now - this.lastCursorSent < 30000) return;
		} else {
			if (!isResend && now - this.lastCursorSent < CURSOR_THROTTLE_MS) return;
		}
		this.lastCursorSent = now;
		const typing = Date.now() - this.lastLocalEditAt < 2500;
		this.send({ type: 'cursor', path: view.file.path, line: cursor.line, ch: cursor.ch, sel, typing, user: this.settings.user, clientId: this.clientId, color: this.color });
	}

	/** Our last cursor line in `path` (-1 if unknown / other file). */
	cursorLineFor(path) {
		if (this.myCursor && this.myCursor.path === path) return this.myCursor.line || 0;
		return -1;
	}

	onRemoteCursor(msg) {
		if (!msg || msg.clientId === this.clientId || !msg.user) return;
		const c = { user: msg.user, clientId: msg.clientId, color: msg.color || colorFor(msg.user), path: sanitizePath(msg.path || ''), line: msg.line || 0, ch: msg.ch || 0, typing: !!msg.typing, sel: msg.sel || null, updatedAt: Date.now() };
		this.remoteCursors.set(msg.clientId, c);
		const u = this.remoteUsers.get(msg.clientId);
		if (u) { u.path = c.path; u.line = c.line; u.typing = c.typing; u.sel = c.sel; u.color = c.color; }
		else this.remoteUsers.set(msg.clientId, { ...c });
		this.refreshPresence();
		this.scheduleFlags();
	}

	openRemoteCursor(c) {
		if (!c.path) return;
		const f = this.app.vault.getAbstractFileByPath(c.path);
		if (!f) { new Notice(this.t('fileGone') + c.path); return; }
		this.app.workspace.openLinkText(c.path, '', false).then(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.editor) {
				try { view.editor.setCursor({ line: c.line || 0, ch: c.ch || 0 }); view.editor.focus(); } catch (e) { /* ignore */ }
			}
		});
	}

	/**
	 * Remote cursors as exact-position flags via CodeMirror coordinates.
	 * No line counting, no text insertion: flag is an overlay div positioned
	 * at the true cursor coords. File content is never touched.
	 */
	getEditorView(view) {
		try {
			const ev = view && view.editor && view.editor.cm;
			if (ev && ev.state && ev.state.doc && ev.coordsAtPos && ev.contentDOM) return ev;
		} catch (e) { /* ignore */ }
		return null;
	}

	scheduleFlags(force) {
		if (this.settings.showRemoteLines === false && !force) return;
		const now = Date.now();
		if (!force && now - this._hlAt < 150) {
			if (!this._hlTimer) {
				this._hlTimer = setTimeout(() => { this._hlTimer = null; this._hlAt = Date.now(); this.refreshCursorFlags(); }, 150);
			}
			return;
		}
		this._hlAt = now;
		this.refreshCursorFlags();
	}

	refreshCursorFlags() {
		try {
			document.querySelectorAll('.unison-flag').forEach(el => el.remove());
			document.querySelectorAll('.unison-sel').forEach(el => el.remove());
			if (this.settings.showRemoteLines === false || !this.connected) return;
			let view = null;
			try { view = this.app.workspace.getActiveViewOfType(MarkdownView); } catch (e) { return; }
			if (!view || !view.file || !view.contentEl) return;
			const ev = this.getEditorView(view);
			if (!ev) {
				if (!this._noCmLogged) { this._noCmLogged = true; this.log('no CM view - cursors in panel only'); }
				return;
			}
			const scroller = view.contentEl.querySelector('.cm-scroller');
			if (!scroller) return;
			this.hookScrollerScroll(scroller);
			const scRect = scroller.getBoundingClientRect();
			const doc = ev.state.doc;
			const toScrollerCoords = (r) => ({
				top: r.top - scRect.top + scroller.scrollTop,
				left: r.left - scRect.left + scroller.scrollLeft,
			});
			const now = Date.now();
			for (const c of this.remoteCursors.values()) {
				if (!c.path || c.path !== view.file.path) continue;
				if (now - (c.updatedAt || 0) > 25000) continue;
				const color = c.color || '#2196f3';
				// selection blocks
				if (c.sel && c.sel.a && c.sel.h) {
					const from = c.sel.a, to = c.sel.h;
					const firstLn = Math.max(1, Math.min(from.line, to.line) + 1);
					const lastLn = Math.min(doc.lines, Math.max(from.line, to.line) + 1);
					if (lastLn - firstLn <= 300) {
						for (let n = firstLn; n <= lastLn; n++) {
							let line = null;
							try { line = doc.line(n); } catch (e) { continue; }
							const cs = (n === from.line + 1) ? from.ch : 0;
							const ce = (n === to.line + 1) ? to.ch : line.length;
							const p1 = line.from + Math.min(cs, line.length);
							const p2 = line.from + Math.min(ce, line.length);
							if (p2 <= p1) continue;
							let r1 = null, r2 = null;
							try { r1 = ev.coordsAtPos(p1); r2 = ev.coordsAtPos(p2); } catch (e) { continue; }
							if (!r1 || !r2) continue;
							const a = toScrollerCoords(r1), b = toScrollerCoords(r2);
							const box = document.createElement('div');
							box.className = 'unison-sel';
							box.style.top = a.top + 'px';
							box.style.left = Math.min(a.left, b.left) + 'px';
							box.style.width = Math.max(2, Math.abs(b.left - a.left)) + 'px';
							box.style.height = Math.max(8, r1.bottom - r1.top) + 'px';
							box.style.background = color;
							scroller.appendChild(box);
						}
					}
				}
				// caret
				let pos = null;
				try {
					const lineNo = Math.min(Math.max(1, (c.line || 0) + 1), doc.lines);
					const line = doc.line(lineNo);
					pos = line.from + Math.min(c.ch || 0, line.length);
				} catch (e) { continue; }
				let r = null;
				try { r = ev.coordsAtPos(pos); } catch (e) { continue; }
				if (!r) continue; // not rendered (outside viewport)
				const pt = toScrollerCoords(r);
				const flag = document.createElement('div');
				flag.className = 'unison-flag';
				flag.style.top = pt.top + 'px';
				flag.style.left = pt.left + 'px';
				flag.style.setProperty('--unison-color', color);
				const caret = document.createElement('span');
				caret.className = 'unison-flag-caret';
				flag.appendChild(caret);
				scroller.appendChild(flag);
			}
		} catch (e) { /* non-fatal */ }
	}

	hookScrollerScroll(scroller) {
		try {
			if (scroller._unisonHook) return;
			scroller._unisonHook = true;
			scroller.addEventListener('scroll', () => this.scheduleFlags(), { passive: true });
		} catch (e) { /* ignore */ }
	}

	/** Drop collaborators silent >25s so stale flags disappear. */
	sweepStaleCursors() {
		const now = Date.now();
		let changed = false;
		for (const [id, c] of this.remoteCursors) {
			if (now - (c.updatedAt || 0) > 25000) { this.remoteCursors.delete(id); changed = true; }
		}
		if (changed) { this.refreshPresence(); this.scheduleFlags(true); }
	}
};

// exposed for unit tests (does not affect Obsidian loading)
module.exports.threeWayMerge = threeWayMerge;
module.exports.diffLineOps = diffLineOps;
module.exports.unionLines = unionLines;
module.exports.mergeUnknownBase = mergeUnknownBase;
module.exports.PresenceView = PresenceView;
