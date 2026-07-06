const DEFAULT_LOCALE = "en";
const AUTO_LOCALE = "auto";
const SUPPORTED_LOCALES = Object.freeze(["en", "ko"]);
const LOCALE_STORAGE_KEY = "a0-launcher-locale";
const LOCALE_CHANGED_EVENT = "dm:i18n";

const MESSAGES = Object.freeze({
  en: Object.freeze({
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.dismiss": "Dismiss",
    "common.launcher": "Launcher",
    "common.reload": "Reload",
    "common.detach": "Detach",

    "sidebar.sections": "Launcher sections",
    "sidebar.instances": "Instances",
    "sidebar.installs": "Installs",
    "sidebar.advanced": "Advanced",
    "sidebar.settings": "Settings",
    "sidebar.resources": "Agent Zero resources",
    "sidebar.docs": "Docs",
    "sidebar.apiDashboard": "API Dashboard",
    "sidebar.support": "Support",

    "instances.title": "Instances",
    "instances.subtitle": "Detected from Docker daemon",
    "instances.createLocal": "Create local Instance",
    "instances.createLocalTitle": "Install a version before creating a local Instance",
    "instances.addRemote": "Add remote Instance",

    "instanceTabs.aria": "Instance UI tabs",
    "instanceTabs.empty": "Open an instance UI to keep it here.",
    "instanceTabs.showLauncher": "Show launcher",
    "instanceTabs.reloadActive": "Reload active instance UI",
    "instanceTabs.detachActive": "Detach active instance UI",

    "remote.add.title": "Add remote Instance",
    "remote.add.submit": "Add Instance",
    "remote.url.label": "Instance URL",
    "remote.url.placeholder": "https://agent-zero.example.com",
    "remote.url.hint": "Use the URL where this Agent Zero Instance is already running. If no protocol is entered, the launcher will use http://.",
    "remote.name.label": "Display name",
    "remote.name.placeholder": "Remote Instance",
    "remote.name.hint": "Optional. This is only the friendly name shown in Instances.",
    "remote.url.invalid": "Enter a valid Instance URL.",

    "settings.title": "Settings",
    "settings.subtitle": "Launcher defaults for new Instances",
    "settings.language.label": "Language",
    "settings.language.auto": "System default",
    "settings.language.en": "English",
    "settings.language.ko": "한국어",
    "settings.language.hint": "Used by the Launcher UI on this computer.",
    "settings.tabs.aria": "Settings",
    "settings.tabs.ports": "Ports",
    "settings.tabs.workspace": "Workspace",
    "settings.tabs.defaults": "Instance defaults",
    "settings.ports.title": "Port Defaults",
    "settings.ports.subtitle": "Starting host ports for new local Instances",
    "settings.ports.ui": "UI Port",
    "settings.ports.uiHint": "Preferred starting host port for the web UI. Existing Instances keep their assigned port.",
    "settings.ports.ssh": "SSH Port",
    "settings.ports.sshHint": "Preferred starting host port when the image exposes SSH. Not every container does.",
    "settings.workspace.title": "Workspace Storage",
    "settings.workspace.subtitle": "Default workspace location for new local Instances",
    "settings.workspace.mode": "Workspace mode",
    "settings.workspace.hostDirectory": "Host directory",
    "settings.workspace.namedVolume": "Named Docker volume",
    "settings.workspace.hostFolder": "Host folder",
    "settings.workspace.hostFolderHint": "Parent folder for per-Instance workspaces.",
    "settings.workspace.folderMapping": "Folder mapping",
    "settings.workspace.perInstance": "Separate folder per Instance",
    "settings.workspace.exact": "Use this folder directly",
    "settings.workspace.mappingHint": "Direct mapping mounts the chosen folder itself at /a0/usr.",
    "settings.workspace.volumePrefix": "Volume prefix",
    "settings.workspace.volumePrefixHint": "Prefix for new named Docker volumes.",
    "settings.defaults.title": "Instance Defaults",
    "settings.defaults.subtitle": "Preferred providers and models for new Instances",
    "settings.defaults.mainUtility": "Main and Utility",
    "settings.defaults.savedHint": "Saved on this computer and applied when you run a new Agent Zero Instance.",
    "settings.defaults.advanced": "Advanced",
    "settings.defaults.embedding": "Embedding model",
    "settings.save": "Save settings",
    "settings.saved": "Settings saved.",
    "settings.savePartial": "Some settings could not be saved."
  }),
  ko: Object.freeze({
    "common.cancel": "취소",
    "common.close": "닫기",
    "common.dismiss": "닫기",
    "common.launcher": "Launcher",
    "common.reload": "새로고침",
    "common.detach": "분리",

    "sidebar.sections": "Launcher 섹션",
    "sidebar.instances": "인스턴스",
    "sidebar.installs": "설치",
    "sidebar.advanced": "고급",
    "sidebar.settings": "설정",
    "sidebar.resources": "Agent Zero 리소스",
    "sidebar.docs": "문서",
    "sidebar.apiDashboard": "API 대시보드",
    "sidebar.support": "지원",

    "instances.title": "인스턴스",
    "instances.subtitle": "Docker 데몬에서 감지됨",
    "instances.createLocal": "로컬 인스턴스 만들기",
    "instances.createLocalTitle": "로컬 인스턴스를 만들기 전에 버전을 설치하세요",
    "instances.addRemote": "원격 인스턴스 추가",

    "instanceTabs.aria": "인스턴스 UI 탭",
    "instanceTabs.empty": "인스턴스 UI를 열면 여기에 유지됩니다.",
    "instanceTabs.showLauncher": "Launcher 표시",
    "instanceTabs.reloadActive": "활성 인스턴스 UI 새로고침",
    "instanceTabs.detachActive": "활성 인스턴스 UI 분리",

    "remote.add.title": "원격 인스턴스 추가",
    "remote.add.submit": "인스턴스 추가",
    "remote.url.label": "인스턴스 URL",
    "remote.url.placeholder": "https://agent-zero.example.com",
    "remote.url.hint": "이미 실행 중인 Agent Zero 인스턴스의 URL을 입력하세요. 프로토콜을 입력하지 않으면 Launcher가 http://를 사용합니다.",
    "remote.name.label": "표시 이름",
    "remote.name.placeholder": "원격 인스턴스",
    "remote.name.hint": "선택 사항입니다. 인스턴스 목록에 표시할 이름으로만 사용됩니다.",
    "remote.url.invalid": "올바른 인스턴스 URL을 입력하세요.",

    "settings.title": "설정",
    "settings.subtitle": "새 인스턴스의 Launcher 기본값",
    "settings.language.label": "언어",
    "settings.language.auto": "시스템 기본값",
    "settings.language.en": "English",
    "settings.language.ko": "한국어",
    "settings.language.hint": "이 컴퓨터의 Launcher UI에 사용됩니다.",
    "settings.tabs.aria": "설정",
    "settings.tabs.ports": "포트",
    "settings.tabs.workspace": "작업공간",
    "settings.tabs.defaults": "인스턴스 기본값",
    "settings.ports.title": "포트 기본값",
    "settings.ports.subtitle": "새 로컬 인스턴스의 시작 호스트 포트",
    "settings.ports.ui": "UI 포트",
    "settings.ports.uiHint": "웹 UI에 사용할 시작 호스트 포트입니다. 기존 인스턴스는 할당된 포트를 유지합니다.",
    "settings.ports.ssh": "SSH 포트",
    "settings.ports.sshHint": "이미지가 SSH를 노출할 때 사용할 시작 호스트 포트입니다. 모든 컨테이너가 SSH를 제공하지는 않습니다.",
    "settings.workspace.title": "작업공간 저장소",
    "settings.workspace.subtitle": "새 로컬 인스턴스의 기본 작업공간 위치",
    "settings.workspace.mode": "작업공간 모드",
    "settings.workspace.hostDirectory": "호스트 디렉터리",
    "settings.workspace.namedVolume": "Docker 이름 지정 볼륨",
    "settings.workspace.hostFolder": "호스트 폴더",
    "settings.workspace.hostFolderHint": "인스턴스별 작업공간을 만들 상위 폴더입니다.",
    "settings.workspace.folderMapping": "폴더 매핑",
    "settings.workspace.perInstance": "인스턴스마다 별도 폴더",
    "settings.workspace.exact": "이 폴더를 직접 사용",
    "settings.workspace.mappingHint": "직접 매핑은 선택한 폴더 자체를 /a0/usr에 마운트합니다.",
    "settings.workspace.volumePrefix": "볼륨 접두사",
    "settings.workspace.volumePrefixHint": "새 Docker 이름 지정 볼륨의 접두사입니다.",
    "settings.defaults.title": "인스턴스 기본값",
    "settings.defaults.subtitle": "새 인스턴스에 사용할 기본 provider와 model",
    "settings.defaults.mainUtility": "Main 및 Utility",
    "settings.defaults.savedHint": "이 컴퓨터에 저장되며 새 Agent Zero 인스턴스를 실행할 때 적용됩니다.",
    "settings.defaults.advanced": "고급",
    "settings.defaults.embedding": "Embedding model",
    "settings.save": "설정 저장",
    "settings.saved": "설정이 저장되었습니다.",
    "settings.savePartial": "일부 설정을 저장하지 못했습니다."
  })
});

function normalizeSupportedLocale(value) {
  const locale = String(value || "").trim().toLowerCase();
  if (!locale) return "";
  if (locale === "ko" || locale.startsWith("ko-")) return "ko";
  if (locale === "en" || locale.startsWith("en-")) return "en";
  return "";
}

function storedLocale() {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function browserLocales() {
  const nav = globalThis.navigator || {};
  const languages = Array.isArray(nav.languages) ? nav.languages : [];
  return [...languages, nav.language || ""].filter(Boolean);
}

function getLauncherLocale(candidates = [storedLocale(), ...browserLocales()]) {
  for (const candidate of candidates) {
    const locale = normalizeSupportedLocale(candidate);
    if (locale && SUPPORTED_LOCALES.includes(locale)) return locale;
  }
  return DEFAULT_LOCALE;
}

function getLauncherLocalePreference() {
  return normalizeSupportedLocale(storedLocale()) || AUTO_LOCALE;
}

function refreshLauncherTranslations() {
  const doc = globalThis.document;
  const locale = getLauncherLocale();
  if (doc?.documentElement) doc.documentElement.lang = locale;
  applyLauncherTranslations(doc, locale);
  return locale;
}

function setLauncherLocalePreference(value) {
  const locale = normalizeSupportedLocale(value);
  try {
    if (locale) globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
    else globalThis.localStorage?.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
  const resolvedLocale = refreshLauncherTranslations();
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent(LOCALE_CHANGED_EVENT, {
      detail: {
        locale: resolvedLocale,
        preference: getLauncherLocalePreference()
      }
    }));
  } catch {
    // CustomEvent may be unavailable in minimal test contexts.
  }
  return getLauncherLocalePreference();
}

function formatMessage(message, values = {}) {
  return String(message).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

function t(key, values = {}, locale = getLauncherLocale()) {
  const dictionary = MESSAGES[locale] || MESSAGES[DEFAULT_LOCALE];
  const message = dictionary[key] || MESSAGES[DEFAULT_LOCALE][key] || key;
  return formatMessage(message, values);
}

function translateAttribute(element, sourceAttribute, targetAttribute, locale) {
  const key = element.getAttribute(sourceAttribute);
  if (!key) return;
  element.setAttribute(targetAttribute, t(key, {}, locale));
}

function translateElement(element, locale) {
  if (element.hasAttribute("data-i18n")) {
    element.textContent = t(element.getAttribute("data-i18n"), {}, locale);
  }
  translateAttribute(element, "data-i18n-title", "title", locale);
  translateAttribute(element, "data-i18n-placeholder", "placeholder", locale);
  translateAttribute(element, "data-i18n-aria-label", "aria-label", locale);
}

function translatableElements(root) {
  const selector = "[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]";
  const elements = [];
  if (root?.nodeType === 1 && root.matches?.(selector)) elements.push(root);
  if (root?.querySelectorAll) elements.push(...root.querySelectorAll(selector));
  return elements;
}

function applyLauncherTranslations(root = globalThis.document, locale = getLauncherLocale()) {
  if (!root) return;
  for (const element of translatableElements(root)) translateElement(element, locale);
}

let observer = null;

function initLauncherI18n() {
  const doc = globalThis.document;
  if (!doc) return;
  refreshLauncherTranslations();
  if (!doc.body || typeof MutationObserver === "undefined") return;
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) applyLauncherTranslations(node);
      }
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });
}

export {
  AUTO_LOCALE,
  DEFAULT_LOCALE,
  LOCALE_CHANGED_EVENT,
  SUPPORTED_LOCALES,
  applyLauncherTranslations,
  getLauncherLocale,
  getLauncherLocalePreference,
  initLauncherI18n,
  setLauncherLocalePreference,
  t
};
