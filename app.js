// File-type helpers — work for both base64 data URLs and saved uploads/ URLs.
function checkIsImage(url) {
  if (!url) return false;
  return url.startsWith('data:image/') || /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url);
}
function checkIsPdf(url) {
  if (!url) return false;
  return url.startsWith('data:application/pdf') || /\.pdf(\?|$)/i.test(url);
}
function checkIsText(url) {
  if (!url) return false;
  return url.startsWith('data:text/') || url.startsWith('data:application/rtf') || /\.(txt|rtf|csv)(\?|$)/i.test(url);
}

// Uploads a base64 data URL to the dev server, which stores it in the uploads/ folder
// and returns a relative URL (e.g. "uploads/invoice_123.jpg"). On any failure it returns
// the original base64 so the document is never lost (it just stays inline in localStorage).
async function uploadFileToServer(base64Data, filename) {
  if (!base64Data || !base64Data.startsWith('data:')) {
    return base64Data; // already a URL or empty — nothing to upload
  }
  const apiEndpoint = window.location.protocol === 'file:'
    ? 'http://127.0.0.1:8080/api/upload-file'
    : '/api/upload-file';
  try {
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename || 'file', base64Data })
    });
    if (!response.ok) {
      let errMsg = `Upload status ${response.status}`;
      try { const j = await response.json(); if (j && j.error) errMsg = j.error; } catch (_) {}
      throw new Error(errMsg);
    }
    const result = await response.json();
    if (result && result.success && result.url) {
      return result.url;
    }
    throw new Error(result.error || 'Unknown upload response');
  } catch (err) {
    console.warn('File upload failed, keeping inline base64:', err);
    return base64Data;
  }
}

// Best-effort deletion of a previously uploaded file from the server's uploads/
// folder. Only acts on "uploads/..." URLs — base64/data URLs and external links
// have no server file. Fire-and-forget: the entry is removed locally regardless.
function deleteFileFromServer(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('uploads/')) {
    return;
  }
  const apiEndpoint = window.location.protocol === 'file:'
    ? 'http://127.0.0.1:8080/api/delete-file'
    : '/api/delete-file';
  fetch(apiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: imageUrl })
  }).catch(err => console.warn('Failed to delete server file:', imageUrl, err));
}

// Resolves an "uploads/..." reference to a fetchable URL (absolute to the dev
// server when the page is opened via file://).
function resolveUploadUrl(url) {
  if (window.location.protocol === 'file:' && url.startsWith('uploads/')) {
    return 'http://127.0.0.1:8080/' + url;
  }
  return url;
}

// Gathers the unique "uploads/..." file references across all backed-up data,
// so a backup can bundle the actual files (the data only stores URL references).
function collectUploadUrls() {
  const urls = new Set();
  const add = (u) => { if (typeof u === 'string' && u.startsWith('uploads/')) urls.add(u); };
  (state.documents || []).forEach(d => add(d.image));
  (state.generalDocs || []).forEach(d => add(d.image));
  (state.staffGeneralDocs || []).forEach(d => add(d.image));
  (state.staff || []).forEach(p => (p.documents || []).forEach(sd => add(sd.image)));
  return Array.from(urls);
}

// Restores a single bundled file back into the server's uploads/ folder under
// its ORIGINAL name, so the URL references in the restored data stay valid.
async function restoreFileToServer(filename, base64Data) {
  const apiEndpoint = window.location.protocol === 'file:'
    ? 'http://127.0.0.1:8080/api/restore-file'
    : '/api/restore-file';
  try {
    const r = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, base64Data })
    });
    return r.ok;
  } catch (err) {
    console.warn('Failed to restore server file:', filename, err);
    return false;
  }
}

// Writes every "uploads/<name>" entry bundled in a restore ZIP back to the
// server, preserving names. Returns counts so the UI can report results.
async function restoreUploadsFromZip(zip) {
  const entries = [];
  zip.forEach((relPath, entry) => {
    if (!entry.dir && relPath.indexOf('uploads/') === 0) entries.push(entry);
  });
  let restored = 0;
  for (const entry of entries) {
    try {
      const base64 = await entry.async('base64');
      const name = entry.name.substring('uploads/'.length);
      if (!name) continue;
      const ok = await restoreFileToServer(name, 'data:application/octet-stream;base64,' + base64);
      if (ok) restored++;
    } catch (err) {
      console.warn('Restore: could not write', entry.name, err);
    }
  }
  return { total: entries.length, restored };
}

// The admin password gates deletions AND access to the Settings panel.
// Defaults to "1234" until the user changes it in Settings (an empty value
// also falls back to the default, so the gate can never be removed entirely).
const DEFAULT_ADMIN_PASSWORD = '1234';
function getAdminPassword() {
  return (localStorage.getItem('admin_delete_password') || '').trim() || DEFAULT_ADMIN_PASSWORD;
}

// Becomes true once the admin password is entered this session, so the Settings
// panel doesn't re-prompt every time it's opened. Resets on page reload.
let settingsUnlocked = false;
function unlockSettings() {
  if (settingsUnlocked) return true;
  const entered = prompt('Въведете администраторска парола за достъп до настройките:');
  if (entered === null) return false; // cancelled
  if (entered.trim() === getAdminPassword()) {
    settingsUnlocked = true;
    return true;
  }
  showToast('Грешна администраторска парола.', 'alert-triangle');
  return false;
}

// Gates a delete action behind the admin password. Drop-in replacement for
// confirm(): returns true only when the user types the correct admin password.
function confirmDelete(message) {
  const entered = prompt(`${message}\n\nВъведете администраторска парола, за да изтриете:`);
  if (entered === null) return false; // cancelled
  if (entered.trim() === getAdminPassword()) return true;
  showToast('Грешна администраторска парола. Изтриването е отменено.', 'alert-triangle');
  return false;
}

// ==========================================
// Server-side state sync (single shared dataset, token-gated)
// ==========================================
// Keys mirrored to the server so every device shares them. Per-device only
// (never synced): app_access_pin (the login credential itself), theme.
const SYNC_KEYS = [
  'saved_documents', 'saved_general_documents', 'saved_staff',
  'saved_staff_general_documents', 'saved_unattached_staff_docs',
  'my_company_name', 'cloudconvert_format',
  'gemini_api_key', 'cloudconvert_api_key', 'admin_delete_password'
];
let syncSuspended = false; // true while applying server data, to avoid echoing it back

// The Access PIN doubles as the sync credential (sent as X-Sync-Token), so
// sync is automatic once a device is logged in — no separate key to configure.
function getSyncKey() { return (localStorage.getItem('app_access_pin') || '1234').trim(); }
function syncEndpoint(path) {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:8080' + path : path;
}

// Mirror writes to synced keys up to the server (debounced per key).
(function () {
  const original = localStorage.setItem.bind(localStorage);
  const timers = {};
  localStorage.setItem = function (key, value) {
    original(key, value);
    if (syncSuspended || SYNC_KEYS.indexOf(key) === -1) return;
    if (sessionStorage.getItem('authenticated') !== 'true') return; // only sync once logged in
    const token = getSyncKey();
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      fetch(syncEndpoint('/api/save-state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
        body: JSON.stringify({ key, value })
      }).then(async (r) => {
        if (!r.ok) {
          let msg = 'HTTP ' + r.status;
          try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        }
        hideSyncError();
      }).catch((err) => {
        console.warn('Sync save failed for', key, err);
        showSyncError('Грешка при синхронизация със сървъра: ' + (err && err.message ? err.message : 'мрежова грешка'));
      });
    }, 600);
  };
})();

// Applies the server's shared dataset into localStorage + state. If the server
// is empty (first run), seeds it from whatever this device already has.
function applyServerData(data) {
  data = data || {};
  if (Object.keys(data).length === 0) {
    SYNC_KEYS.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v != null) localStorage.setItem(k, v); // triggers the sync interceptor -> seeds server
    });
    return;
  }
  syncSuspended = true;
  SYNC_KEYS.forEach((k) => {
    if (data[k] !== undefined && data[k] !== null) {
      localStorage.setItem(k, data[k]);
    }
  });
  syncSuspended = false;
  // Fill gaps: push any synced key this device has but the server lacks (e.g. a
  // setting that became syncable only after it was already set on this device,
  // like the admin delete password). Runs once until the server has it.
  SYNC_KEYS.forEach((k) => {
    const local = localStorage.getItem(k);
    if ((data[k] === undefined || data[k] === null) && local != null) {
      localStorage.setItem(k, local); // triggers the interceptor -> seeds server
    }
  });
  reloadStateFromLocalStorage();
}

// Pulls the shared dataset from the server (only meaningful once logged in).
async function loadStateFromServer() {
  if (sessionStorage.getItem('authenticated') !== 'true') return; // pull only after login
  let r, result;
  try {
    r = await fetch(syncEndpoint('/api/load-state'), { headers: { 'X-Sync-Token': getSyncKey() } });
    result = await r.json();
  } catch (err) {
    console.warn('Sync load failed:', err);
    showSyncError('Няма връзка със сървъра за синхронизация. Работите локално.');
    return;
  }
  if (!r.ok || !result || !result.success) {
    if (r.status === 401) showSyncError('PIN кодът не съвпада с този на сървъра.');
    return;
  }
  applyServerData(result.data);
  hideSyncError();
}

// Re-reads synced values from localStorage into in-memory state + the UI.
function reloadStateFromLocalStorage() {
  try {
    state.documents = JSON.parse(localStorage.getItem('saved_documents')) || [];
    state.generalDocs = JSON.parse(localStorage.getItem('saved_general_documents')) || [];
    state.staff = JSON.parse(localStorage.getItem('saved_staff')) || [];
    state.staffGeneralDocs = JSON.parse(localStorage.getItem('saved_staff_general_documents')) || [];
    state.unattachedStaffDocs = JSON.parse(localStorage.getItem('saved_unattached_staff_docs')) || [];
  } catch (e) {
    console.warn('Failed to parse restored state arrays', e);
  }
  state.apiKey = localStorage.getItem('gemini_api_key') || '';
  state.cloudConvertApiKey = localStorage.getItem('cloudconvert_api_key') || '';
  state.cloudConvertFormat = localStorage.getItem('cloudconvert_format') || 'pdf';
  state.myCompany = localStorage.getItem('my_company_name') || '';

  if (elements.apiKeyInput) elements.apiKeyInput.value = state.apiKey;
  if (elements.cloudConvertApiKeyInput) elements.cloudConvertApiKeyInput.value = state.cloudConvertApiKey;
  if (elements.cloudConvertFormatSelect) elements.cloudConvertFormatSelect.value = state.cloudConvertFormat;
  if (elements.headerCompanyInput) elements.headerCompanyInput.value = state.myCompany;
  if (elements.adminPasswordInput) elements.adminPasswordInput.value = getAdminPassword();
  updateApiKeyBadge();
  updateCloudConvertApiKeyBadge();

  migrateOldDocuments();
  renderDocumentList();
  renderGeneralDocumentList();
  renderStaffList();
  renderStaffGeneralDocsList();
}

function showSyncError(message) {
  const banner = document.getElementById('sync-banner');
  const msgEl = document.getElementById('sync-banner-message');
  if (msgEl && message) msgEl.textContent = message;
  if (banner) banner.classList.remove('hidden');
}
function hideSyncError() {
  const banner = document.getElementById('sync-banner');
  if (banner) banner.classList.add('hidden');
}

// State Management
let state = {
  apiKey: localStorage.getItem('gemini_api_key') || '',
  cloudConvertApiKey: localStorage.getItem('cloudconvert_api_key') || '',
  cloudConvertFormat: localStorage.getItem('cloudconvert_format') || 'pdf', // 'pdf' or 'png' — target for unsupported file types
  documents: JSON.parse(localStorage.getItem('saved_documents')) || [],
  generalDocs: JSON.parse(localStorage.getItem('saved_general_documents')) || [],
  staff: JSON.parse(localStorage.getItem('saved_staff')) || [],
  unattachedStaffDocs: JSON.parse(localStorage.getItem('saved_unattached_staff_docs')) || [],
  
  activePage: 'invoices', // 'invoices', 'documents', or 'staff'
  activeExpenseMonth: new Date().toISOString().slice(0, 7), // "YYYY-MM"
  
  // Page 1 (Invoices) state
  activeSource: 'camera', // 'camera' or 'upload'
  activeTab: 'invoices', // 'invoices', 'receipts', or 'other'
  capturedImageBase64: null, // Full compressed base64 JPEG
  capturedFileName: null,
  capturedFileExtension: '',
  currentPage: 1,
  pageSize: 20,

  // Page 2 (Documents) state
  activeSourceDocs: 'camera',
  activeTabDocs: 'permit', // 'permit', 'contract', 'trade', or 'other'
  capturedImageBase64Docs: null,
  capturedFileNameDocs: null,
  capturedFileExtensionDocs: '',
  currentPageDocs: 1,
  pageSizeDocs: 20,

  // Page 3 (Staff) state
  activeSourceStaff: 'camera',
  capturedImageBase64Staff: null,
  capturedFileNameStaff: null,
  capturedFileExtensionStaff: '',

  webcamStream: null,
  currentlyViewingDocId: null,
  currentlyViewingDocIdDocs: null, // For general docs details modal
  currentlyViewingStaffPersonId: null, // For staff person sub-doc details
  currentlyViewingStaffDocId: null, // For staff sub-doc details
  theme: localStorage.getItem('theme') || 'dark', // 'dark' or 'light'
  myCompany: localStorage.getItem('my_company_name') || '',
  isProcessingMultipleFiles: false,
  
  // Page 3 (Staff) general docs state
  activeTabStaffGen: 'payroll', // 'payroll', 'schedule', or 'other'
  currentPageStaffGen: 1,
  pageSizeStaffGen: 10,
  staffGeneralDocs: JSON.parse(localStorage.getItem('saved_staff_general_documents')) || []
};

// DOM Elements
const elements = {
  // Header
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeIcon: document.getElementById('theme-icon'),
  apiKeyBadge: document.getElementById('api-key-badge'),
  headerCompanyInput: document.getElementById('header-company-input'),
  btnSettingsGear: document.getElementById('btn-settings-gear'),
  
  // Navigation Tabs
  navInvoices: document.getElementById('nav-invoices'),
  navDocuments: document.getElementById('nav-documents'),
  navStaff: document.getElementById('nav-staff'),
  
  // Backup & Restore
  btnBackup: document.getElementById('btn-backup'),
  btnRestore: document.getElementById('btn-restore'),
  backupFileInput: document.getElementById('backup-file-input'),
  backupPanel: document.querySelector('.backup-panel'),
  
  // View Containers
  viewInvoices: document.getElementById('view-invoices'),
  viewDocuments: document.getElementById('view-documents'),
  viewStaff: document.getElementById('view-staff'),
  
  // Expandable Capture Controls
  btnExpandCapture: document.getElementById('btn-expand-capture'),
  capturePanelInvoices: document.getElementById('capture-panel-invoices'),
  btnCloseCaptureInvoices: document.getElementById('btn-close-capture-invoices'),
  
  btnExpandCaptureDocs: document.getElementById('btn-expand-capture-docs'),
  capturePanelDocs: document.getElementById('capture-panel-docs'),
  btnCloseCaptureDocs: document.getElementById('btn-close-capture-docs'),
  
  btnExpandCaptureStaff: document.getElementById('btn-expand-capture-staff'),
  capturePanelStaff: document.getElementById('capture-panel-staff'),
  btnCloseCaptureStaff: document.getElementById('btn-close-capture-staff'),
  
  // View 1 (Invoices) Toggles & Panels
  toggleCamera: document.getElementById('toggle-camera'),
  toggleUpload: document.getElementById('toggle-upload'),
  cameraView: document.getElementById('camera-view'),
  uploadView: document.getElementById('upload-view'),
  videoFeed: document.getElementById('video-feed'),
  photoCanvas: document.getElementById('photo-canvas'),
  cameraPlaceholder: document.getElementById('camera-placeholder'),
  btnRetryCamera: document.getElementById('btn-retry-camera'),
  btnCapture: document.getElementById('btn-capture'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  previewContainer: document.getElementById('preview-container'),
  imagePreview: document.getElementById('image-preview'),
  btnRotatePreview: document.getElementById('btn-rotate-preview'),
  btnResetPreview: document.getElementById('btn-reset-preview'),
  btnTranscribe: document.getElementById('btn-transcribe'),
  docCount: document.getElementById('doc-count'),
  searchInput: document.getElementById('search-input'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  btnClearAll: document.getElementById('btn-clear-all'),
  documentList: document.getElementById('document-list'),
  filterStartDate: document.getElementById('filter-start-date'),
  filterEndDate: document.getElementById('filter-end-date'),
  btnClearDates: document.getElementById('btn-clear-dates'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  pageIndicator: document.getElementById('page-indicator'),
  tabsNav: document.querySelector('.tabs-nav'),
  tabLinks: document.querySelectorAll('#view-invoices .tab-link'),
  badgeCountInvoices: document.getElementById('badge-count-invoices'),
  badgeCountBills: document.getElementById('badge-count-bills'),
  badgeCountRevenueInvoices: document.getElementById('badge-count-revenue-invoices'),
  badgeCountReceipts: document.getElementById('badge-count-receipts'),
  badgeCountTaxes: document.getElementById('badge-count-taxes'),
  badgeCountOther: document.getElementById('badge-count-other'),
  invoiceSummary: document.getElementById('invoice-summary'),
  monthlyExpenseSummary: document.getElementById('monthly-expense-summary'),
  monthlyExpenseLabel: document.getElementById('monthly-expense-label'),
  monthlyExpenseValue: document.getElementById('monthly-expense-value'),
  btnPrevMonth: document.getElementById('btn-prev-month'),
  btnNextMonth: document.getElementById('btn-next-month'),
  invoiceTotalValue: document.getElementById('invoice-total-value'),
  invoiceTodayValue: document.getElementById('invoice-today-value'),

  // View 2 (General Documents) Toggles & Panels
  toggleCameraDocs: document.getElementById('toggle-camera-docs'),
  toggleUploadDocs: document.getElementById('toggle-upload-docs'),
  cameraViewDocs: document.getElementById('camera-view-docs'),
  uploadViewDocs: document.getElementById('upload-view-docs'),
  dropzoneDocs: document.getElementById('dropzone-docs'),
  fileInputDocs: document.getElementById('file-input-docs'),
  previewContainerDocs: document.getElementById('preview-container-docs'),
  imagePreviewDocs: document.getElementById('image-preview-docs'),
  btnRotatePreviewDocs: document.getElementById('btn-rotate-preview-docs'),
  btnResetPreviewDocs: document.getElementById('btn-reset-preview-docs'),
  btnTranscribeDocs: document.getElementById('btn-transcribe-docs'),
  docCountDocs: document.getElementById('doc-count-docs'),
  searchInputDocs: document.getElementById('search-input-docs'),
  btnClearSearchDocs: document.getElementById('btn-clear-search-docs'),
  btnClearAllDocs: document.getElementById('btn-clear-all-docs'),
  documentListDocs: document.getElementById('document-list-docs'),
  filterStartDateDocs: document.getElementById('filter-start-date-docs'),
  filterEndDateDocs: document.getElementById('filter-end-date-docs'),
  btnClearDatesDocs: document.getElementById('btn-clear-dates-docs'),
  btnPrevPageDocs: document.getElementById('btn-prev-page-docs'),
  btnNextPageDocs: document.getElementById('btn-next-page-docs'),
  pageIndicatorDocs: document.getElementById('page-indicator-docs'),
  docTabLinks: document.querySelectorAll('#view-documents .tab-link'),
  badgeCountPermits: document.getElementById('badge-count-permits'),
  badgeCountContracts: document.getElementById('badge-count-contracts'),
  badgeCountTrade: document.getElementById('badge-count-trade'),
  badgeCountStatement: document.getElementById('badge-count-statement'),
  badgeCountGeneralOther: document.getElementById('badge-count-general-other'),
  
  // View 3 (Personnel) Toggles & Panels
  toggleCameraStaff: document.getElementById('toggle-camera-staff'),
  toggleUploadStaff: document.getElementById('toggle-upload-staff'),
  cameraViewStaff: document.getElementById('camera-view-staff'),
  uploadViewStaff: document.getElementById('upload-view-staff'),
  dropzoneStaff: document.getElementById('dropzone-staff'),
  fileInputStaff: document.getElementById('file-input-staff'),
  previewContainerStaff: document.getElementById('preview-container-staff'),
  imagePreviewStaff: document.getElementById('image-preview-staff'),
  btnRotatePreviewStaff: document.getElementById('btn-rotate-preview-staff'),
  btnResetPreviewStaff: document.getElementById('btn-reset-preview-staff'),
  btnTranscribeStaff: document.getElementById('btn-transcribe-staff'),
  docCountStaff: document.getElementById('doc-count-staff'),
  searchInputStaff: document.getElementById('search-input-staff'),
  btnClearSearchStaff: document.getElementById('btn-clear-search-staff'),
  staffList: document.getElementById('staff-list'),
  
  // View 3 General Staff Docs Panel
  badgeCountPayroll: document.getElementById('badge-count-payroll'),
  badgeCountSchedule: document.getElementById('badge-count-schedule'),
  badgeCountStaffOther: document.getElementById('badge-count-staff-other'),
  staffGeneralDocsCount: document.getElementById('staff-general-docs-count'),
  staffGenTabLinks: document.querySelectorAll('#panel-staff-general-docs .tab-link'),
  btnPrevPageStaffGen: document.getElementById('btn-prev-page-staff-gen'),
  btnNextPageStaffGen: document.getElementById('btn-next-page-staff-gen'),
  pageIndicatorStaffGen: document.getElementById('page-indicator-staff-gen'),
  
  // Add Staff Modal Controls
  btnAddStaff: document.getElementById('btn-add-staff'),
  modalAddStaff: document.getElementById('modal-add-staff'),
  btnAddStaffName: document.getElementById('add-staff-name'),
  btnAddStaffPosition: document.getElementById('add-staff-position'),
  btnAddStaffDate: document.getElementById('add-staff-date'),
  btnSubmitAddStaff: document.getElementById('btn-submit-add-staff'),
  
  // Add Expense Modal Controls
  btnAddExpenseNoFile: document.getElementById('btn-add-expense-no-file'),
  modalAddExpenseNoFile: document.getElementById('modal-add-expense-no-file'),
  btnAddExpenseName: document.getElementById('add-expense-name'),
  btnAddExpenseDate: document.getElementById('add-expense-date'),
  btnAddExpenseAmount: document.getElementById('add-expense-amount'),
  btnSubmitAddExpense: document.getElementById('btn-submit-add-expense'),
  
  // Settings
  apiKeyInput: document.getElementById('api-key-input'),
  cloudConvertApiKeyInput: document.getElementById('cloudconvert-api-key-input'),
  cloudConvertApiKeyBadge: document.getElementById('cloudconvert-api-key-badge'),
  cloudConvertFormatSelect: document.getElementById('cloudconvert-format-select'),
  appPinInput: document.getElementById('app-pin-input'),
  adminPasswordInput: document.getElementById('admin-password-input'),
  btnSyncRefresh: document.getElementById('btn-sync-refresh'),
  
  // Lightbox Modal
  modalImage: document.getElementById('modal-image'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxCaption: document.getElementById('lightbox-caption'),
  
  // Detailed View Modal (Invoices)
  modalView: document.getElementById('modal-view'),
  viewTitle: document.getElementById('view-title'),
  viewImgPreview: document.getElementById('view-img-preview'),
  btnViewExpand: document.getElementById('btn-view-expand'),
  viewTextContent: document.getElementById('view-text-content'),
  viewDate: document.getElementById('view-date'),
  btnDeleteDoc: document.getElementById('btn-delete-doc'),
  btnCopyText: document.getElementById('btn-copy-text'),
  
  // General Documents Details Modal
  modalDocDetails: document.getElementById('modal-doc-details'),
  viewDocName: document.getElementById('view-doc-name'),
  viewDocIssueDate: document.getElementById('view-doc-issue-date'),
  viewDocExpiryDate: document.getElementById('view-doc-expiry-date'),
  viewDocCategory: document.getElementById('view-doc-category'),
  viewDocText: document.getElementById('view-doc-text'),
  containerViewDocText: document.getElementById('container-view-doc-text'),
  containerViewDocProducts: document.getElementById('container-view-doc-products'),
  modalDocProductsBody: document.getElementById('modal-doc-products-body'),
  btnAddDocProduct: document.getElementById('btn-add-doc-product'),
  btnDeleteDocGeneral: document.getElementById('btn-delete-doc-general'),
  modalDocPreviewImg: document.getElementById('modal-doc-preview-img'),
  modalDocPreviewPlaceholder: document.getElementById('modal-doc-preview-placeholder'),
  modalDocBtnViewFull: document.getElementById('modal-doc-btn-view-full'),
  viewDocSavedDate: document.getElementById('view-doc-saved-date'),
  
  // Staff Document Details Modal
  modalStaffDocDetails: document.getElementById('modal-staff-doc-details'),
  viewStaffDocName: document.getElementById('view-staff-doc-name'),
  viewStaffDocUploadDate: document.getElementById('view-staff-doc-upload-date'),
  viewStaffDocText: document.getElementById('view-staff-doc-text'),
  btnDeleteStaffDocSub: document.getElementById('btn-delete-staff-doc-sub'),
  
  // Toast
  toast: document.getElementById('toast'),
  toastIcon: document.getElementById('toast-icon'),
  toastMessage: document.getElementById('toast-message'),
  
  // Hover Preview
  hoverPreview: document.getElementById('hover-image-preview'),
  hoverPreviewImg: document.getElementById('hover-preview-img')
};

// Initialize Application
function init() {
  // One-time self-heal: an earlier build let the browser autofill the masked
  // admin field and persist that value, locking users out of Settings with a
  // password they never set. Clear it once so the "1234" default applies again.
  // (A user-set password afterwards still persists — this runs only once.)
  if (!localStorage.getItem('admin_pw_reset_v1')) {
    localStorage.removeItem('admin_delete_password');
    localStorage.setItem('admin_pw_reset_v1', '1');
  }

  initPINAuthentication();
  applyTheme();
  updateApiKeyBadge();
  updateCloudConvertApiKeyBadge();
  migrateOldDocuments();
  
  // Initialize settings inputs
  if (elements.headerCompanyInput) {
    elements.headerCompanyInput.value = state.myCompany;
  }
  if (elements.apiKeyInput) {
    elements.apiKeyInput.value = state.apiKey;
  }
  if (elements.cloudConvertApiKeyInput) {
    elements.cloudConvertApiKeyInput.value = state.cloudConvertApiKey;
  }
  if (elements.cloudConvertFormatSelect) {
    elements.cloudConvertFormatSelect.value = state.cloudConvertFormat;
  }
  if (elements.appPinInput) {
    elements.appPinInput.value = localStorage.getItem('app_access_pin') || '1234';
  }
  if (elements.adminPasswordInput) {
    elements.adminPasswordInput.value = getAdminPassword();
  }
  
  renderDocumentList();
  renderGeneralDocumentList();
  renderStaffList();
  renderStaffGeneralDocsList();
  setupEventListeners();
  
  // Responsive Source Selection
  const isMobile = window.innerWidth < 768;
  state.activeSource = isMobile ? 'camera' : 'upload';
  state.activeSourceDocs = isMobile ? 'camera' : 'upload';
  state.activeSourceStaff = isMobile ? 'camera' : 'upload';
  
  updateSourceVisibility();
  updateSourceVisibilityDocs();
  updateSourceVisibilityStaff();
  
  const activePanel = state.activePage === 'invoices' ? elements.capturePanelInvoices : (state.activePage === 'documents' ? elements.capturePanelDocs : elements.capturePanelStaff);
  const activeSrc = state.activePage === 'invoices' ? state.activeSource : (state.activePage === 'documents' ? state.activeSourceDocs : state.activeSourceStaff);
  const isAuthenticated = sessionStorage.getItem('authenticated') === 'true';
  if (isAuthenticated && activeSrc === 'camera' && activePanel && (!activePanel.classList.contains('hidden') || isMobile)) {
    startCamera();
  } else {
    stopCamera();
  }
  
  window.addEventListener('resize', handleScreenResize);

  // Sync-error banner dismiss + initial pull of the shared dataset (no-op if no
  // sync key set on this device).
  const syncBannerClose = document.getElementById('sync-banner-close');
  if (syncBannerClose) syncBannerClose.addEventListener('click', hideSyncError);
  loadStateFromServer();

  // Initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function applyTheme() {
  const isLight = state.theme === 'light';
  if (isLight) {
    document.body.classList.add('light-theme');
  } else {
    document.body.classList.remove('light-theme');
  }
  
  if (elements.themeIcon) {
    elements.themeIcon.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function updateSourceVisibility() {
  if (state.activeSource === 'camera') {
    elements.cameraView.classList.remove('hidden');
    elements.uploadView.classList.add('hidden');
  } else {
    elements.uploadView.classList.remove('hidden');
    elements.cameraView.classList.add('hidden');
  }
}

function updateSourceVisibilityDocs() {
  if (state.activeSourceDocs === 'camera') {
    elements.cameraViewDocs.classList.remove('hidden');
    elements.uploadViewDocs.classList.add('hidden');
  } else {
    elements.uploadViewDocs.classList.remove('hidden');
    elements.cameraViewDocs.classList.add('hidden');
  }
}

function updateSourceVisibilityStaff() {
  if (state.activeSourceStaff === 'camera') {
    elements.cameraViewStaff.classList.remove('hidden');
    elements.uploadViewStaff.classList.add('hidden');
  } else {
    elements.uploadViewStaff.classList.remove('hidden');
    elements.cameraViewStaff.classList.add('hidden');
  }
}

function handleScreenResize() {
  const isMobile = window.innerWidth < 768;
  const newSource = isMobile ? 'camera' : 'upload';
  
  let needsCameraStart = false;
  
  if (state.activeSource !== newSource) {
    state.activeSource = newSource;
    updateSourceVisibility();
    if (state.activeSource === 'camera' && !state.capturedImageBase64 && state.activePage === 'invoices' && (!elements.capturePanelInvoices.classList.contains('hidden') || isMobile)) {
      needsCameraStart = true;
    }
  }
  
  if (state.activeSourceDocs !== newSource) {
    state.activeSourceDocs = newSource;
    updateSourceVisibilityDocs();
    if (state.activeSourceDocs === 'camera' && !state.capturedImageBase64Docs && state.activePage === 'documents' && (!elements.capturePanelDocs.classList.contains('hidden') || isMobile)) {
      needsCameraStart = true;
    }
  }
  
  if (state.activeSourceStaff !== newSource) {
    state.activeSourceStaff = newSource;
    updateSourceVisibilityStaff();
    if (state.activeSourceStaff === 'camera' && !state.capturedImageBase64Staff && state.activePage === 'staff' && (!elements.capturePanelStaff.classList.contains('hidden') || isMobile)) {
      needsCameraStart = true;
    }
  }
  
  if (needsCameraStart) {
    startCamera();
  } else {
    stopCamera();
  }
}

function switchPage(pageId) {
  state.activePage = pageId;
  
  // Update header tab classes
  const navBtns = [elements.navInvoices, elements.navDocuments, elements.navStaff];
  navBtns.forEach(btn => {
    if (btn) {
      if (btn.getAttribute('data-page') === pageId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
  
  // Show / hide views
  const views = {
    'invoices': elements.viewInvoices,
    'documents': elements.viewDocuments,
    'staff': elements.viewStaff
  };
  
  Object.keys(views).forEach(key => {
    const view = views[key];
    if (view) {
      if (key === pageId) {
        view.classList.remove('hidden');
      } else {
        view.classList.add('hidden');
      }
    }
  });
  
  // Stop camera if not in active camera mode, start camera in new view if needed
  stopCamera();
  
  // Force update layout visibility
  updateSourceVisibilityDocs();
  updateSourceVisibilityStaff();
  updateSourceVisibility();
  
  const isMobile = window.innerWidth < 768;
  if (pageId === 'invoices') {
    if (state.activeSource === 'camera' && (!elements.capturePanelInvoices.classList.contains('hidden') || isMobile)) startCamera();
    renderDocumentList();
  } else if (pageId === 'documents') {
    if (state.activeSourceDocs === 'camera' && (!elements.capturePanelDocs.classList.contains('hidden') || isMobile)) startCamera();
    renderGeneralDocumentList();
  } else if (pageId === 'staff') {
    if (state.activeSourceStaff === 'camera' && (!elements.capturePanelStaff.classList.contains('hidden') || isMobile)) startCamera();
    renderStaffList();
    renderStaffGeneralDocsList();
  }
}

// Migration for documents created in previous version
function migrateOldDocuments() {
  let changed = false;
  
  // Normalize existing date strings to YYYY-MM-DD
  state.documents.forEach(doc => {
    if (doc.date) {
      const norm = normalizeDate(doc.date);
      if (norm && doc.date !== norm) {
        doc.date = norm;
        changed = true;
      }
    }
  });

  state.documents.forEach(doc => {
    if (doc.recipient === undefined) {
      doc.recipient = null;
      changed = true;
    }
    if (!doc.products) {
      doc.products = [];
      changed = true;
    } else if (doc.products.length > 0 && typeof doc.products[0] === 'string') {
      doc.products = doc.products.map(p => ({
        name: p,
        quantity: 1,
        price: null
      }));
      changed = true;
    }
    if (!doc.type) {
      const textLower = (doc.transcription || '').toLowerCase();
      if (textLower.includes('фактура')) {
        doc.type = 'invoice';
        const amtMatch = textLower.match(/(?:общо\s+с\s+ддс|обща\s+сума|сума\s+за\s+плащане|сума)[\s:]*(?:€|eur|евро)?[\s:]*([0-9]+[.,][0-9]{2})/);
        if (amtMatch) {
          doc.totalAmount = parseFloat(amtMatch[1].replace(',', '.'));
        }
      } else if (textLower.match(/(receipt|бон|бележка|касова)/)) {
        doc.type = 'receipt';
      } else {
        doc.type = 'other';
      }
      changed = true;
    }
  });
  
  // Migrate expense-invoice type to revenue-invoice type
  state.documents.forEach(doc => {
    if (doc.type === 'expense-invoice') {
      doc.type = 'revenue-invoice';
      changed = true;
    }
  });
  
  // Migrate invoices that match my company to revenue-invoice type
  const myCompanyLower = state.myCompany.toLowerCase().trim();
  if (myCompanyLower) {
    state.documents.forEach(doc => {
      if (doc.type === 'invoice' && myCompanyLower && (doc.supplier || '').toLowerCase().trim() &&
          ((doc.supplier || '').toLowerCase().trim().includes(myCompanyLower) || myCompanyLower.includes((doc.supplier || '').toLowerCase().trim()))) {
        doc.type = 'revenue-invoice';
        changed = true;
      }
    });
  }
  
  if (changed) {
    localStorage.setItem('saved_documents', JSON.stringify(state.documents));
  }
}

// ==========================================
// Web Camera Functions
// ==========================================

async function startCamera() {
  const containerId = state.activePage === 'invoices' ? 'camera-view' : (state.activePage === 'documents' ? 'camera-view-docs' : 'camera-view-staff');
  const container = document.getElementById(containerId);
  if (!container) return;
  
  // Show a nice camera placeholder
  container.innerHTML = `
    <div class="mobile-scan-zone">
      <div class="scan-icon-container">
        <i data-lucide="video-off"></i>
      </div>
      <h3 style="font-size: 1.1rem; font-weight: 600; color: var(--text-primary); margin-top: 0.5rem;">Камерата е изключена / Camera Disabled</h3>
      <p style="font-size: 0.85rem; color: var(--text-secondary); max-width: 320px; margin: 0.5rem auto 0; line-height: 1.4;">
        В тази среда се поддържа само директно качване на файлове. Моля, преминете към раздел <strong>Upload File</strong> или използвайте мобилно устройство, за да заснемете документа в реално време.
      </p>
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();
}
function stopCamera() {}
function capturePhoto() {}

// ==========================================
// Image Compression & Processing
// ==========================================

// Downscales image to fit in localStorage and reduce API payload size
// ==========================================
// Auto-analysis progress bar (shown under the capture/upload controls in place
// of the old Analyze button). One per view: invoices / docs / staff.
// ==========================================
const ANALYZE_PROGRESS_VIEWS = {
  invoices: 'analyze-progress-invoices',
  docs: 'analyze-progress-docs',
  staff: 'analyze-progress-staff'
};
function analyzeProgressEl(view) {
  const id = ANALYZE_PROGRESS_VIEWS[view];
  return id ? document.getElementById(id) : null;
}
function showAnalyzeProgress(view, text) {
  const root = analyzeProgressEl(view);
  if (!root) return;
  root.classList.remove('hidden');
  root.classList.add('indeterminate');
  const fill = root.querySelector('.analyze-progress-bar-fill');
  if (fill) fill.style.width = '';
  const label = root.querySelector('.analyze-progress-text');
  if (label) label.textContent = text || 'Анализиране...';
}
function setAnalyzeProgress(view, current, total) {
  const root = analyzeProgressEl(view);
  if (!root) return;
  root.classList.remove('hidden');
  root.classList.remove('indeterminate');
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const fill = root.querySelector('.analyze-progress-bar-fill');
  if (fill) fill.style.width = pct + '%';
  const label = root.querySelector('.analyze-progress-text');
  if (label) label.textContent = `Анализиране ${current}/${total}...`;
}
function hideAnalyzeProgress(view) {
  const root = analyzeProgressEl(view);
  if (root) root.classList.add('hidden');
}

function processAndPreviewImage(base64Str) {
  const maxWidth = 1200;
  const maxHeight = 1200;
  
  const img = new Image();
  img.src = base64Str;
  img.onload = () => {
    let width = img.width;
    let height = img.height;
    
    // Calculate new dimensions
    if (width > maxWidth || height > maxHeight) {
      if (width > height) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      } else {
        width = Math.round((width * maxHeight) / height);
        height = maxHeight;
      }
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    
    // Store as JPEG with moderate quality
    state.capturedImageBase64 = canvas.toDataURL('image/jpeg', 0.8);
    
    // Autogenerate name if empty
    if (!state.capturedFileName) {
      const now = new Date();
      const dateStr = now.toLocaleDateString();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      state.capturedFileName = `Capture ${dateStr} ${timeStr}`;
    }
    
    // Show the preview, then auto-start analysis immediately.
    elements.imagePreview.src = state.capturedImageBase64;
    elements.previewContainer.classList.remove('hidden');
    transcribeDocument();
  };
}

function resetPreview() {
  state.capturedImageBase64 = null;
  elements.imagePreview.src = '';
  
  // Remove any PDF/document placeholders
  const pdfPlaceholder = document.getElementById('pdf-preview-placeholder');
  if (pdfPlaceholder) {
    pdfPlaceholder.remove();
  }
  elements.imagePreview.classList.remove('hidden');
  elements.btnRotatePreview.classList.remove('hidden');
  
  elements.previewContainer.classList.add('hidden');
  elements.btnTranscribe.disabled = true;
  state.capturedFileName = null;
  state.capturedFileExtension = '';
  
  if (state.activeSource === 'camera') {
    startCamera();
  }
}

function rotateImage90Degrees() {
  if (!state.capturedImageBase64) return;
  
  const img = new Image();
  img.src = state.capturedImageBase64;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Swap width and height for 90 degrees rotation
    canvas.width = img.height;
    canvas.height = img.width;
    
    // Shift context origin, rotate and draw
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(90 * Math.PI / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    
    // Re-encode at standard compression quality
    state.capturedImageBase64 = canvas.toDataURL('image/jpeg', 0.8);
    
    // Refresh preview source
    elements.imagePreview.src = state.capturedImageBase64;
  };
}

// ==========================================
// Gemini API Integration
// ==========================================

async function transcribeDocument() {
  const apiKey = state.apiKey.trim();
  if (!apiKey) {
    showSettingsPanelAndFocusKey();
    return;
  }
  
  if (!state.capturedImageBase64) {
    showToast('Няма зареден файл или снимка.', 'file-text');
    return;
  }
  
  // Set Loading state
  const isBatch = state.isProcessingMultipleFiles;
  if (!isBatch) {
    showAnalyzeProgress('invoices', 'Анализиране на документа...');
  }

  const originalBtnHtml = elements.btnTranscribe.innerHTML;
  if (!isBatch) {
    elements.btnTranscribe.disabled = true;
    elements.btnTranscribe.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Анализиране на документа...</span>`;
    if (window.lucide) window.lucide.createIcons();
  }
  
  try {
    const promptText = `You are an expert document analyzer. Analyze the attached document image or file (could be an image, PDF, Excel sheet, Word doc, RTF, or text file).
Return a JSON object with the exact fields below:
1. "supplier": The billing supplier, company name, or grounds/reason of payment ("доставчик" or "основание за плащане"), if found. For tax/social security documents, return the type of tax or grounds (e.g., "ДДС за м.05" or "Здравни осигуровки"). Return null if not found.
2. "recipient": The billing client or recipient company name ("получател"), if found. Return null if not found.
3. "date": The document date ("дата") in YYYY-MM-DD format (e.g. "2026-06-23"), if found. Return null if not found.
4. "products": An array of objects representing the products or services listed in the document. Each object must have:
   - "name": (string) the name of the product or service.
   - "quantity": (number) the quantity or amount of this product. If not specified, default to 1.
   - "price": (number or null) the unit price or total price for this item. If not specified, return null.
   Example: [{"name": "Кафе еспресо", "quantity": 1, "price": 2.50}, {"name": "Минерална вода", "quantity": 2, "price": 1.20}]. Return an empty array [] if none are found.
4. "totalAmount": The total sum amount with VAT in Euros (€). Look specifically for the price in Euros (€) that appears after phrases like "общо с ддс", "обща сума", "сума за плащане", "сума" (or their English translations like "total with vat", "total sum", "amount to pay", "sum"). Extract the number as a numeric float value. Return null if not found.
5. "inferredType": Classify the document as "invoice", "bills", "receipt", "taxes", or "other".

Rules:
- If the document is a bill, utility bill, or service invoice (contains references to electricity, water, internet, heating, phone, services, utilities, or Bulgarian equivalents like "ток", "вода", "интернет", "парно", "телефон", "услуга", "услуги", "битова сметка", "сметка", "сметки", "такса", "такси", "А1", "Виваком", "Йеттел", "Yettel", "Електрохолд", "EVN", "Енерго-Про", "Софийска вода"), "inferredType" MUST be "bills".
- If the document contains the Bulgarian word "фактура" (or case variations like "ФАКТУРА") and is not a utility bill/service invoice, "inferredType" MUST be "invoice".
- If the document is a cash/sales receipt (contains "бон", "касова бележка", "receipt"), "inferredType" MUST be "receipt".
- If the document is related to taxes, social security, state insurance, municipal fees, declarations, or state payments (contains "данък", "осигуровки", "данъци", "ддс декларация", "нп", "tax", "social security", "insurance"), "inferredType" MUST be "taxes".`;

    const requestBody = await prepareGeminiRequestBody(state.capturedImageBase64, promptText, state.capturedFileExtension);
    
    // Use Gemini 2.5 Flash for fast multimodal operations
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `HTTP error ${response.status}`);
    }
    
    const result = await response.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!responseText) {
      throw new Error('Could not extract text from Gemini API response.');
    }
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (jsonErr) {
      console.warn("Failed to parse Gemini response as JSON, falling back to empty details", jsonErr);
      parsedResult = {
        supplier: null,
        date: null,
        products: [],
        totalAmount: null,
        inferredType: responseText.toLowerCase().includes('фактура') ? 'invoice' : (responseText.toLowerCase().match(/(receipt|бон|бележка|касова)/) ? 'receipt' : 'other')
      };
    }
    
    await saveTranscription(parsedResult);
    showToast('Документът е транскрибиран успешно!', 'check-circle');
    resetPreview();
    if (!isBatch) {
      collapseCapturePanel('invoices');
    }
    
  } catch (err) {
    console.error('Transcription error:', err);
    showToast(`Грешка: ${err.message}`, 'alert-circle');
  } finally {
    if (!isBatch) {
      hideAnalyzeProgress('invoices');
      elements.btnTranscribe.disabled = false;
      elements.btnTranscribe.innerHTML = originalBtnHtml;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

// ==========================================
// Gemini API Integration (General Documents & Staff)
// ==========================================

async function transcribeGeneralDocument() {
  const apiKey = state.apiKey.trim();
  if (!apiKey) {
    showSettingsPanelAndFocusKey();
    return;
  }
  
  if (!state.capturedImageBase64Docs) {
    showToast('Няма зареден файл или снимка.', 'file-text');
    return;
  }
  
  // Set Loading state
  const isBatch = state.isProcessingMultipleFiles;
  if (!isBatch) {
    showAnalyzeProgress('docs', 'Анализиране...');
  }

  const originalBtnHtml = elements.btnTranscribeDocs.innerHTML;
  if (!isBatch) {
    elements.btnTranscribeDocs.disabled = true;
    elements.btnTranscribeDocs.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Анализиране...</span>`;
    if (window.lucide) window.lucide.createIcons();
  }
  
  try {
    const promptText = `You are an expert document analyzer. Analyze the attached document image or file.
Extract the document information and return a JSON object with the exact fields below:
1. "name": A concise, descriptive name for the document in Bulgarian (e.g., "Разрешително за строеж", "Договор за наем", "Анекс към договор", "Сертификат за съответствие", etc.). If no name can be inferred, return "Документ".
2. "type": Classify the document type. It MUST be one of: "permit" (for permits, licenses, certificates, authorizations), "contract" (for agreements, annexes, lease/sale contracts, work contracts), "trade" (for commercial offers, delivery notes/protocols, commercial/trade documents, purchase orders, trade agreements, supplier invoices/documents), "statement" (for bank statements, bank extracts, account statements, financial statements), or "other" (for any other type of document).
3. "issueDate": The issue or signing date ("дата на издаване / сключване") in YYYY-MM-DD format (e.g. "2026-06-23"). Return null if not found.
4. "expiryDate": The expiration or validity date ("валиден до / срок на действие") in YYYY-MM-DD format. Return null if not found.
5. "supplier": The name of the supplier, seller, vendor, or partner company mentioned in the document. Return null if not found.
6. "products": If type is "trade", extract the list of products/items listed in the document. Return a JSON array of objects, where each object has: "product" (string, product name in Bulgarian/original), "batch" (string or null, batch/lot number if mentioned), "expiry" (string or null, expiry or best-before date in YYYY-MM-DD format). If no products are found or type is not "trade", return an empty array [].
7. "text": The full text transcript or key content of the document.

Rules:
- Default to Bulgarian language for the "name" and "supplier" fields if possible.
- If it is a permit, certificate, license, or similar authorization, set type to "permit".
- If it is a contract, agreement, annex, or deal, set type to "contract".
- If it is a commercial offer, trade proposal, delivery protocol, supplier document/invoice, order, set type to "trade".
- If it is a bank statement, bank extract, financial statement, account activity statement/extract, set type to "statement".
- Otherwise, set type to "other".`;

    const requestBody = await prepareGeminiRequestBody(state.capturedImageBase64Docs, promptText, state.capturedFileExtensionDocs);
    
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `HTTP error ${response.status}`);
    }
    
    const result = await response.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!responseText) {
      throw new Error('Could not extract text from Gemini API response.');
    }
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (jsonErr) {
      console.warn("Failed to parse Gemini response as JSON", jsonErr);
      parsedResult = {
        name: state.capturedFileNameDocs || 'Документ',
        type: 'other',
        issueDate: null,
        expiryDate: null,
        supplier: null,
        products: [],
        text: responseText
      };
    }
    
    await saveGeneralDocTranscription(parsedResult);
    showToast('Документът е анализиран успешно!', 'check-circle');
    resetPreviewDocs();
    if (!isBatch) {
      collapseCapturePanel('documents');
    }
    
  } catch (err) {
    console.error('General doc transcription error:', err);
    showToast(`Грешка: ${err.message}`, 'alert-circle');
  } finally {
    if (!isBatch) {
      hideAnalyzeProgress('docs');
      elements.btnTranscribeDocs.disabled = false;
      elements.btnTranscribeDocs.innerHTML = originalBtnHtml;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

async function transcribeStaffDocument() {
  const apiKey = state.apiKey.trim();
  if (!apiKey) {
    showSettingsPanelAndFocusKey();
    return;
  }
  
  if (!state.capturedImageBase64Staff) {
    showToast('Няма зареден файл или снимка.', 'file-text');
    return;
  }
  
  // Set Loading state
  const isBatch = state.isProcessingMultipleFiles;
  if (!isBatch) {
    showAnalyzeProgress('staff', 'Анализиране...');
  }

  const originalBtnHtml = elements.btnTranscribeStaff.innerHTML;
  if (!isBatch) {
    elements.btnTranscribeStaff.disabled = true;
    elements.btnTranscribeStaff.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Анализиране...</span>`;
    if (window.lucide) window.lucide.createIcons();
  }
  
  try {
    const promptText = `You are an expert document analyzer for human resources / personnel documents. Analyze the attached employee/staff document.
Extract the relevant details and return a JSON object with the exact fields below:
1. "docCategory": Classify the document category. It MUST be one of:
   - "payroll" (for payroll sheets, salary ledgers, payroll lists, "ведомости за заплати")
   - "schedule" (for shift schedules, rosters, duty calendars, "графици за дежурства")
   - "personal" (for employee-specific records like labor contracts, vacation requests, warnings, hiring/firing orders, personnel files)
   - "other" (for general files, policies, or if category cannot be inferred)
2. "employeeName": The full name of the employee ("три имена на служителя") in Bulgarian, if docCategory is "personal" (or if a specific employee name is prominent). Return null if not found.
3. "employeePosition": The position/role/title of the employee ("длъжност"), if docCategory is "personal". Return null if not found.
4. "docName": The specific name of the document in Bulgarian (e.g., "Ведомост за заплати - Юни 2026", "График за дежурства", "Трудов договор", "Молба за отпуск"). If not found, return "Документ".
5. "issueDate": The signing, issue, or period date of the document in YYYY-MM-DD format. Look for payment dates or schedule month dates. Return null if not found.
6. "hiringDate": The employee's hiring/start date in YYYY-MM-DD format, if docCategory is "personal". Return null if not found.
7. "fullText": The complete text transcript or key content of the document.

Rules:
- Be very accurate in extracting the names. Use standard Bulgarian spelling.`;

    const requestBody = await prepareGeminiRequestBody(state.capturedImageBase64Staff, promptText, state.capturedFileExtensionStaff);
    
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `HTTP error ${response.status}`);
    }
    
    const result = await response.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!responseText) {
      throw new Error('Could not extract text from Gemini API response.');
    }
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (jsonErr) {
      console.warn("Failed to parse Gemini response as JSON", jsonErr);
      parsedResult = {
        docCategory: 'other',
        employeeName: null,
        employeePosition: null,
        docName: state.capturedFileNameStaff || 'Документ на служител',
        issueDate: null,
        hiringDate: null,
        fullText: responseText
      };
    }
    
    await saveStaffDocTranscription(parsedResult);
    showToast('Документът е анализиран успешно!', 'check-circle');
    resetPreviewStaff();
    if (!isBatch) {
      collapseCapturePanel('staff');
    }
    
  } catch (err) {
    console.error('Staff doc transcription error:', err);
    showToast(`Грешка: ${err.message}`, 'alert-circle');
  } finally {
    if (!isBatch) {
      hideAnalyzeProgress('staff');
      elements.btnTranscribeStaff.disabled = false;
      elements.btnTranscribeStaff.innerHTML = originalBtnHtml;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

function resetPreviewDocs() {
  state.capturedImageBase64Docs = null;
  elements.imagePreviewDocs.src = '';
  
  const pdfPlaceholder = document.getElementById('pdf-preview-placeholder-docs');
  if (pdfPlaceholder) {
    pdfPlaceholder.remove();
  }
  elements.imagePreviewDocs.classList.remove('hidden');
  elements.btnRotatePreviewDocs.classList.remove('hidden');
  
  elements.previewContainerDocs.classList.add('hidden');
  elements.btnTranscribeDocs.disabled = true;
  state.capturedFileNameDocs = null;
  state.capturedFileExtensionDocs = '';
  
  if (state.activeSourceDocs === 'camera') {
    startCamera();
  }
}

function resetPreviewStaff() {
  state.capturedImageBase64Staff = null;
  elements.imagePreviewStaff.src = '';
  
  const pdfPlaceholder = document.getElementById('pdf-preview-placeholder-staff');
  if (pdfPlaceholder) {
    pdfPlaceholder.remove();
  }
  elements.imagePreviewStaff.classList.remove('hidden');
  elements.btnRotatePreviewStaff.classList.remove('hidden');
  
  elements.previewContainerStaff.classList.add('hidden');
  elements.btnTranscribeStaff.disabled = true;
  state.capturedFileNameStaff = null;
  state.capturedFileExtensionStaff = '';
  
  if (state.activeSourceStaff === 'camera') {
    startCamera();
  }
}

function rotateImage90DegreesDocs() {
  if (!state.capturedImageBase64Docs) return;
  
  const img = new Image();
  img.src = state.capturedImageBase64Docs;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.height;
    canvas.height = img.width;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(90 * Math.PI / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    state.capturedImageBase64Docs = canvas.toDataURL('image/jpeg', 0.8);
    elements.imagePreviewDocs.src = state.capturedImageBase64Docs;
  };
}

function rotateImage90DegreesStaff() {
  if (!state.capturedImageBase64Staff) return;
  
  const img = new Image();
  img.src = state.capturedImageBase64Staff;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.height;
    canvas.height = img.width;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(90 * Math.PI / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    state.capturedImageBase64Staff = canvas.toDataURL('image/jpeg', 0.8);
    elements.imagePreviewStaff.src = state.capturedImageBase64Staff;
  };
}

function handleFileDocs(file) {
  if (shouldConvertToPdf(file)) {
    elements.imagePreviewDocs.src = '';
    elements.imagePreviewDocs.classList.add('hidden');
    elements.btnRotatePreviewDocs.classList.add('hidden');
    
    const existingPlaceholder = document.getElementById('pdf-preview-placeholder-docs');
    if (existingPlaceholder) {
      existingPlaceholder.remove();
    }
    
    const placeholder = document.createElement('div');
    placeholder.id = 'pdf-preview-placeholder-docs';
    placeholder.className = 'document-preview-placeholder';
    placeholder.innerHTML = `
      <div class="doc-placeholder-icon">
        <i data-lucide="loader-2" class="animate-spin"></i>
      </div>
      <div class="doc-placeholder-info">
        <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
        <div class="doc-placeholder-size">Конвертиране в ${state.cloudConvertFormat === 'png' ? 'PNG' : 'PDF'}...</div>
      </div>
    `;
    
    elements.previewContainerDocs.appendChild(placeholder);
    elements.previewContainerDocs.classList.remove('hidden');
    elements.btnTranscribeDocs.disabled = true;
    
    if (window.lucide) {
      window.lucide.createIcons();
    }
    
    convertFileToPdf(file)
      .then(pdfFile => {
        handleFileDocs(pdfFile);
      })
      .catch(err => {
        const formatName = file.name.substring(file.name.lastIndexOf('.')).toUpperCase().substring(1);
        showToast(`Грешка при конвертиране на ${formatName}: ${err.message}`, 'alert-circle');
        resetPreviewDocs();
      });
    return;
  }

  const lastDotIndex = file.name.lastIndexOf('.');
  state.capturedFileNameDocs = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex) : file.name;
  state.capturedFileExtensionDocs = lastDotIndex !== -1 ? file.name.substring(lastDotIndex).toLowerCase() : '';

  const reader = new FileReader();
  reader.onload = (e) => {
    if (file.type.startsWith('image/')) {
      const maxWidth = 1200;
      const maxHeight = 1200;
      
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        state.capturedImageBase64Docs = canvas.toDataURL('image/jpeg', 0.8);
        
        elements.imagePreviewDocs.src = state.capturedImageBase64Docs;
        elements.previewContainerDocs.classList.remove('hidden');
        transcribeGeneralDocument(); // auto-start analysis
      };
    } else {
      state.capturedImageBase64Docs = e.target.result;
      
      elements.imagePreviewDocs.src = '';
      elements.imagePreviewDocs.classList.add('hidden');
      elements.btnRotatePreviewDocs.classList.add('hidden');
      
      const existingPlaceholder = document.getElementById('pdf-preview-placeholder-docs');
      if (existingPlaceholder) {
        existingPlaceholder.remove();
      }
      
      const iconName = getIconForMime(e.target.result);
      const placeholder = document.createElement('div');
      placeholder.id = 'pdf-preview-placeholder-docs';
      placeholder.className = 'document-preview-placeholder';
      
      const fileSizeFormatted = file.size > 1024 * 1024 
        ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
        : (file.size / 1024).toFixed(1) + ' KB';
        
      placeholder.innerHTML = `
        <div class="doc-placeholder-icon">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="doc-placeholder-info">
          <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
          <div class="doc-placeholder-size">${fileSizeFormatted}</div>
        </div>
      `;
      
      elements.previewContainerDocs.appendChild(placeholder);
      elements.previewContainerDocs.classList.remove('hidden');

      if (window.lucide) {
        window.lucide.createIcons();
      }
      transcribeGeneralDocument(); // auto-start analysis
    }
  };
  reader.readAsDataURL(file);
}

function handleFileStaff(file) {
  if (shouldConvertToPdf(file)) {
    elements.imagePreviewStaff.src = '';
    elements.imagePreviewStaff.classList.add('hidden');
    elements.btnRotatePreviewStaff.classList.add('hidden');
    
    const existingPlaceholder = document.getElementById('pdf-preview-placeholder-staff');
    if (existingPlaceholder) {
      existingPlaceholder.remove();
    }
    
    const placeholder = document.createElement('div');
    placeholder.id = 'pdf-preview-placeholder-staff';
    placeholder.className = 'document-preview-placeholder';
    placeholder.innerHTML = `
      <div class="doc-placeholder-icon">
        <i data-lucide="loader-2" class="animate-spin"></i>
      </div>
      <div class="doc-placeholder-info">
        <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
        <div class="doc-placeholder-size">Конвертиране в ${state.cloudConvertFormat === 'png' ? 'PNG' : 'PDF'}...</div>
      </div>
    `;
    
    elements.previewContainerStaff.appendChild(placeholder);
    elements.previewContainerStaff.classList.remove('hidden');
    elements.btnTranscribeStaff.disabled = true;
    
    if (window.lucide) {
      window.lucide.createIcons();
    }
    
    convertFileToPdf(file)
      .then(pdfFile => {
        handleFileStaff(pdfFile);
      })
      .catch(err => {
        const formatName = file.name.substring(file.name.lastIndexOf('.')).toUpperCase().substring(1);
        showToast(`Грешка при конвертиране на ${formatName}: ${err.message}`, 'alert-circle');
        resetPreviewStaff();
      });
    return;
  }

  const lastDotIndex = file.name.lastIndexOf('.');
  state.capturedFileNameStaff = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex) : file.name;
  state.capturedFileExtensionStaff = lastDotIndex !== -1 ? file.name.substring(lastDotIndex).toLowerCase() : '';

  const reader = new FileReader();
  reader.onload = (e) => {
    if (file.type.startsWith('image/')) {
      const maxWidth = 1200;
      const maxHeight = 1200;
      
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        state.capturedImageBase64Staff = canvas.toDataURL('image/jpeg', 0.8);
        
        elements.imagePreviewStaff.src = state.capturedImageBase64Staff;
        elements.previewContainerStaff.classList.remove('hidden');
        transcribeStaffDocument(); // auto-start analysis
      };
    } else {
      state.capturedImageBase64Staff = e.target.result;
      
      elements.imagePreviewStaff.src = '';
      elements.imagePreviewStaff.classList.add('hidden');
      elements.btnRotatePreviewStaff.classList.add('hidden');
      
      const existingPlaceholder = document.getElementById('pdf-preview-placeholder-staff');
      if (existingPlaceholder) {
        existingPlaceholder.remove();
      }
      
      const iconName = getIconForMime(e.target.result);
      const placeholder = document.createElement('div');
      placeholder.id = 'pdf-preview-placeholder-staff';
      placeholder.className = 'document-preview-placeholder';
      
      const fileSizeFormatted = file.size > 1024 * 1024 
        ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
        : (file.size / 1024).toFixed(1) + ' KB';
        
      placeholder.innerHTML = `
        <div class="doc-placeholder-icon">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="doc-placeholder-info">
          <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
          <div class="doc-placeholder-size">${fileSizeFormatted}</div>
        </div>
      `;
      
      elements.previewContainerStaff.appendChild(placeholder);
      elements.previewContainerStaff.classList.remove('hidden');

      if (window.lucide) {
        window.lucide.createIcons();
      }
      transcribeStaffDocument(); // auto-start analysis
    }
  };
  reader.readAsDataURL(file);
}

// ==========================================
// Data Persistence (localStorage)
// ==========================================

async function saveTranscription(parsedResult) {
  const name = state.capturedFileName || 'Untitled Document';
  
  // Classify based on uploader name, supplier details, or inferred type
  const isInvoiceKeyword = name.toLowerCase().includes('фактура') || 
                            (parsedResult.supplier && parsedResult.supplier.toLowerCase().includes('фактура'));
  
  const isTaxesKeyword = name.toLowerCase().match(/(данък|осигуровки|данъци|ддс декларация|нп|tax|social security|insurance)/) ||
                         (parsedResult.supplier && parsedResult.supplier.toLowerCase().match(/(данък|осигуровки|данъци|ддс декларация|нп|tax|social security|insurance)/));
                             
  const isBillsKeyword = name.toLowerCase().match(/(ток|вода|интернет|парно|телефон|сметка|сметки|битова|услуга|услуги|такса|такси|а1|виваком|йеттел|yettel|vivacom|електрохолд|evn|енерго|софийска вода|bill|utility|utilities|service|services)/) ||
                         (parsedResult.supplier && parsedResult.supplier.toLowerCase().match(/(ток|вода|интернет|парно|телефон|сметка|сметки|битова|услуга|услуги|такса|такси|а1|виваком|йеттел|yettel|vivacom|електрохолд|evn|енерго|софийска вода|bill|utility|utilities|service|services)/));
                             
  let finalType = parsedResult.inferredType || 'other';
  if (finalType === 'bills' || isBillsKeyword) {
    finalType = 'bills';
  } else if (isInvoiceKeyword || finalType === 'invoice') {
    finalType = 'invoice';
  } else if (finalType === 'receipt') {
    finalType = 'receipt';
  } else if (isTaxesKeyword || finalType === 'taxes') {
    finalType = 'taxes';
  }
  
  // Auto-route to revenue-invoice if supplier matches my company
  const myCompanyLower = state.myCompany.toLowerCase().trim();
  const supplierLower = (parsedResult.supplier || '').toLowerCase().trim();
  if (finalType === 'invoice' && myCompanyLower && supplierLower &&
      (supplierLower.includes(myCompanyLower) || myCompanyLower.includes(supplierLower))) {
    finalType = 'revenue-invoice';
  }
  
  const newDoc = {
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    name: name,
    supplier: parsedResult.supplier,
    recipient: parsedResult.recipient || null,
    date: normalizeDate(parsedResult.date) || new Date().toISOString().slice(0, 10),
    products: parsedResult.products || [],
    totalAmount: parsedResult.totalAmount != null ? parseFloat(parsedResult.totalAmount) : null,
    type: finalType,
    image: await uploadFileToServer(state.capturedImageBase64, state.capturedFileName || 'invoice'),
    timestamp: Date.now()
  };
  
  // Save to start of list
  state.documents.unshift(newDoc);
  
  try {
    localStorage.setItem('saved_documents', JSON.stringify(state.documents));
  } catch (e) {
    console.error('Storage full, removing oldest entry', e);
    if (state.documents.length > 1) {
      state.documents.pop();
      try {
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
      } catch (innerErr) {
        showToast('Паметта е пълна! Изчистете старите документи.', 'alert-triangle');
      }
    }
  }
  
  renderDocumentList();
}

async function saveGeneralDocTranscription(parsedResult) {
  const name = parsedResult.name || state.capturedFileNameDocs || 'Untitled Document';

  const newDoc = {
    id: 'gdoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    name: name,
    type: parsedResult.type || 'other',
    image: await uploadFileToServer(state.capturedImageBase64Docs, state.capturedFileNameDocs || 'document'),
    issueDate: normalizeDate(parsedResult.issueDate) || new Date().toISOString().slice(0, 10),
    expiryDate: normalizeDate(parsedResult.expiryDate),
    supplier: parsedResult.supplier || null,
    products: parsedResult.products || [],
    text: parsedResult.text || '',
    timestamp: Date.now()
  };
  
  state.generalDocs.unshift(newDoc);
  
  try {
    localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
  } catch (e) {
    console.error('Storage full, removing oldest entry', e);
    if (state.generalDocs.length > 1) {
      state.generalDocs.pop();
      localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
    }
  }
  
  renderGeneralDocumentList();
}

async function saveStaffDocTranscription(parsedResult) {
  const category = parsedResult.docCategory || 'other';
  const docName = parsedResult.docName || state.capturedFileNameStaff || 'Документ';
  const issueDate = normalizeDate(parsedResult.issueDate) || new Date().toISOString().slice(0, 10);

  // Save the file into uploads/ once; reuse the returned URL for whichever bucket it lands in.
  const imageUrl = await uploadFileToServer(state.capturedImageBase64Staff, state.capturedFileNameStaff || 'staff_doc');

  if (category === 'payroll' || category === 'schedule' || (category === 'other' && !parsedResult.employeeName)) {
    // Save to general staff documents
    const newGenDoc = {
      id: 'sgdoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: docName,
      type: category, // 'payroll', 'schedule', 'other'
      image: imageUrl,
      date: issueDate,
      timestamp: Date.now()
    };
    
    state.staffGeneralDocs.unshift(newGenDoc);
    
    try {
      localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));
    } catch (e) {
      console.error('Storage full, removing oldest entry', e);
      if (state.staffGeneralDocs.length > 1) {
        state.staffGeneralDocs.pop();
        localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));
      }
    }
    
    renderStaffGeneralDocsList();
    showToast('Документът е записан в общите документи на персонала!', 'check-circle');
    return;
  }
  
  // Otherwise, it's a personal employee document
  const employeeName = (parsedResult.employeeName || '').trim();
  const newSubDoc = {
    id: 'sdoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    name: docName,
    image: imageUrl,
    uploadDate: issueDate,
    fullText: parsedResult.fullText || ''
  };
  
  // Try to find active employee by name match
  let employee = null;
  if (employeeName) {
    employee = state.staff.find(e => !e.isArchived && e.name.toLowerCase().trim() === employeeName.toLowerCase());
  }
  
  if (employee) {
    // If found, append document
    employee.documents.unshift(newSubDoc);
    // Update hiring date if we got a new one and it wasn't set yet
    if (parsedResult.hiringDate && !employee.hiringDate) {
      employee.hiringDate = normalizeDate(parsedResult.hiringDate);
    }
    // Update position if we got a new one and it wasn't set yet
    if (parsedResult.employeePosition && !employee.position) {
      employee.position = parsedResult.employeePosition.trim();
    }
    
    try {
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    } catch (e) {
      console.error('Storage full', e);
    }
    
    showToast(`Документът е прикачен към ${employee.name} успешно!`, 'check-circle');
  } else {
    // Save as unattached document
    const unattachedDoc = {
      id: 'udoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: docName,
      image: imageUrl,
      uploadDate: issueDate,
      extractedName: employeeName,
      extractedPosition: parsedResult.employeePosition ? parsedResult.employeePosition.trim() : '',
      extractedHiringDate: parsedResult.hiringDate ? normalizeDate(parsedResult.hiringDate) : '',
      fullText: parsedResult.fullText || ''
    };
    
    state.unattachedStaffDocs.unshift(unattachedDoc);
    
    try {
      localStorage.setItem('saved_unattached_staff_docs', JSON.stringify(state.unattachedStaffDocs));
    } catch (e) {
      console.error('Storage full', e);
    }
    
    showToast('Документът е запазен като неприкачен (не е намерен съвпадащ служител).', 'info');
  }
  
  renderStaffList();
}

function deleteGeneralDocument(id) {
  const doc = state.generalDocs.find(d => d.id === id);
  if (doc) deleteFileFromServer(doc.image);
  state.generalDocs = state.generalDocs.filter(d => d.id !== id);
  localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
  renderGeneralDocumentList();
  closeModal(elements.modalDocDetails);
  showToast('Документът е изтрит.', 'trash-2');
}

function deleteStaffPerson(personId) {
  const person = state.staff.find(p => p.id === personId);
  if (person && Array.isArray(person.documents)) {
    person.documents.forEach(d => deleteFileFromServer(d.image));
  }
  state.staff = state.staff.filter(p => p.id !== personId);
  localStorage.setItem('saved_staff', JSON.stringify(state.staff));
  renderStaffList();
  showToast('Служителят е изтрит.', 'trash-2');
}

function deleteStaffDocument(personId, docId) {
  const person = state.staff.find(p => p.id === personId);
  if (person) {
    const sub = person.documents.find(d => d.id === docId);
    if (sub) deleteFileFromServer(sub.image);
    person.documents = person.documents.filter(d => d.id !== docId);
    localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    renderStaffList();
    showToast('Документът е изтрит.', 'trash-2');
  }
}

function attachUnattachedDoc(docId, optionValue) {
  const doc = state.unattachedStaffDocs.find(d => d.id === docId);
  if (!doc) return;
  
  const subDoc = {
    id: 'sdoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    name: doc.name,
    image: doc.image,
    uploadDate: doc.uploadDate,
    fullText: doc.fullText
  };
  
  if (optionValue === 'new_extracted') {
    const newEmpName = doc.extractedName || 'Нов служител';
    const newEmp = {
      id: 'emp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: newEmpName,
      hiringDate: doc.extractedHiringDate || new Date().toISOString().slice(0, 10),
      position: doc.extractedPosition || '',
      isArchived: false,
      archiveDate: null,
      documents: [subDoc]
    };
    state.staff.unshift(newEmp);
    state.unattachedStaffDocs = state.unattachedStaffDocs.filter(d => d.id !== docId);
    
    localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    localStorage.setItem('saved_unattached_staff_docs', JSON.stringify(state.unattachedStaffDocs));
    showToast(`Създаден е служител ${newEmpName} и документът е прикачен успешно!`, 'check-circle');
  } 
  else if (optionValue === 'new_custom') {
    const newEmpName = prompt('Въведете име за новия служител:');
    if (!newEmpName || !newEmpName.trim()) {
      showToast('Не беше въведено валидно име.', 'alert-triangle');
      return;
    }
    const newEmp = {
      id: 'emp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: newEmpName.trim(),
      hiringDate: doc.extractedHiringDate || new Date().toISOString().slice(0, 10),
      position: doc.extractedPosition || '',
      isArchived: false,
      archiveDate: null,
      documents: [subDoc]
    };
    state.staff.unshift(newEmp);
    state.unattachedStaffDocs = state.unattachedStaffDocs.filter(d => d.id !== docId);
    
    localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    localStorage.setItem('saved_unattached_staff_docs', JSON.stringify(state.unattachedStaffDocs));
    showToast(`Създаден е служител ${newEmp.name} и документът е прикачен успешно!`, 'check-circle');
  } 
  else {
    const employee = state.staff.find(e => e.id === optionValue);
    if (!employee) {
      showToast('Избраният служител не беше намерен.', 'alert-triangle');
      return;
    }
    employee.documents.unshift(subDoc);
    
    if (doc.extractedHiringDate && !employee.hiringDate) {
      employee.hiringDate = doc.extractedHiringDate;
    }
    if (doc.extractedPosition && !employee.position) {
      employee.position = doc.extractedPosition;
    }
    
    state.unattachedStaffDocs = state.unattachedStaffDocs.filter(d => d.id !== docId);
    
    localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    localStorage.setItem('saved_unattached_staff_docs', JSON.stringify(state.unattachedStaffDocs));
    showToast(`Документът е прикачен към ${employee.name} успешно!`, 'check-circle');
  }
  
  renderStaffList();
}

function deleteUnattachedDoc(docId) {
  if (confirmDelete('Наистина ли искате да изтриете този неприкачен документ?')) {
    const doc = state.unattachedStaffDocs.find(d => d.id === docId);
    if (doc) deleteFileFromServer(doc.image);
    state.unattachedStaffDocs = state.unattachedStaffDocs.filter(d => d.id !== docId);
    localStorage.setItem('saved_unattached_staff_docs', JSON.stringify(state.unattachedStaffDocs));
    renderStaffList();
    showToast('Документът е изтрит.', 'trash-2');
  }
}

function deleteDocument(id) {
  const target = state.documents.find(doc => doc.id === id);
  if (target) deleteFileFromServer(target.image);
  state.documents = state.documents.filter(doc => doc.id !== id);
  localStorage.setItem('saved_documents', JSON.stringify(state.documents));
  renderDocumentList();
  closeModal(elements.modalView);
  showToast('Документът е изтрит.', 'trash-2');
}

function clearAllDocuments() {
  if (confirmDelete('Наистина ли искате да изтриете всички записани документи? Това действие е необратимо.')) {
    state.documents.forEach(d => deleteFileFromServer(d.image));
    state.documents = [];
    localStorage.setItem('saved_documents', JSON.stringify(state.documents));
    renderDocumentList();
    showToast('Всички документи са изтрити.', 'trash-2');
  }
}

// Helper to normalize dates to YYYY-MM-DD for date inputs
function normalizeDate(dateStr) {
  if (!dateStr) return '';
  dateStr = dateStr.trim();
  
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  
  // DD.MM.YYYY
  const dotMatch = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const day = dotMatch[1].padStart(2, '0');
    const month = dotMatch[2].padStart(2, '0');
    const year = dotMatch[3];
    return `${year}-${month}-${day}`;
  }
  
  // DD/MM/YYYY
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }
  
  // Try JS parsing
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  
  return '';
}

// Helper to format YYYY-MM-DD date to DD/MM/YYYY for text display
function formatDateForDisplay(dateStr) {
  if (!dateStr) return '';
  const normalized = normalizeDate(dateStr);
  if (!normalized) return '';
  const parts = normalized.split('-');
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${day}/${month}/${year}`;
  }
  return dateStr;
}

// ==========================================
// Rendering List UI
// ==========================================

function renderDocumentList() {
  const filter = elements.searchInput.value.toLowerCase().trim();
  const startDate = elements.filterStartDate ? elements.filterStartDate.value : '';
  const endDate = elements.filterEndDate ? elements.filterEndDate.value : '';
  const listContainer = elements.documentList;
  listContainer.innerHTML = '';
  
  // 1. Calculate filtered lists for all tabs
  const matchesFilter = (doc) => {
    const matchesText = (
      doc.name.toLowerCase().includes(filter) || 
      (doc.transcription || '').toLowerCase().includes(filter) ||
      (doc.supplier && doc.supplier.toLowerCase().includes(filter)) ||
      (doc.recipient && doc.recipient.toLowerCase().includes(filter)) ||
      (doc.products && doc.products.some(p => p.name && p.name.toLowerCase().includes(filter)))
    );

    const docDate = normalizeDate(doc.date);
    let matchesDate = true;
    if (startDate && (!docDate || docDate < startDate)) matchesDate = false;
    if (endDate && (!docDate || docDate > endDate)) matchesDate = false;

    return matchesText && matchesDate;
  };

  const invoicesList = state.documents.filter(doc => 
    doc.type === 'invoice' && matchesFilter(doc)
  );
  
  const billsList = state.documents.filter(doc => 
    doc.type === 'bills' && matchesFilter(doc)
  );
  
  const revenueInvoicesList = state.documents.filter(doc => 
    doc.type === 'revenue-invoice' && matchesFilter(doc)
  );
  
  const receiptsList = state.documents.filter(doc => 
    doc.type === 'receipt' && matchesFilter(doc)
  );
  
  const taxesList = state.documents.filter(doc => 
    doc.type === 'taxes' && matchesFilter(doc)
  );
  
  const otherList = state.documents.filter(doc => 
    doc.type === 'other' && matchesFilter(doc)
  );
  
  // Update Tab Badges with count of matching items
  if (elements.badgeCountInvoices) elements.badgeCountInvoices.textContent = invoicesList.length;
  if (elements.badgeCountBills) elements.badgeCountBills.textContent = billsList.length;
  if (elements.badgeCountRevenueInvoices) elements.badgeCountRevenueInvoices.textContent = revenueInvoicesList.length;
  if (elements.badgeCountReceipts) elements.badgeCountReceipts.textContent = receiptsList.length;
  if (elements.badgeCountTaxes) elements.badgeCountTaxes.textContent = taxesList.length;
  if (elements.badgeCountOther) elements.badgeCountOther.textContent = otherList.length;
  
  // 2. Select active list
  let activeDocs = [];
  if (state.activeTab === 'invoices') {
    activeDocs = invoicesList;
  } else if (state.activeTab === 'bills') {
    activeDocs = billsList;
  } else if (state.activeTab === 'revenue-invoices') {
    activeDocs = revenueInvoicesList;
  } else if (state.activeTab === 'receipts') {
    activeDocs = receiptsList;
  } else if (state.activeTab === 'taxes') {
    activeDocs = taxesList;
  } else {
    activeDocs = otherList;
  }
  
  // Sort: most recent first, missing dates first
  activeDocs.sort((a, b) => {
    const dateA = normalizeDate(a.date);
    const dateB = normalizeDate(b.date);
    if (!dateA && !dateB) return 0;
    if (!dateA) return -1; // missing goes first
    if (!dateB) return 1;  // missing goes first
    return dateB.localeCompare(dateA); // descending
  });

  elements.docCount.textContent = `${activeDocs.length} Елем.`;
  
  // If list is empty, show empty state
  if (activeDocs.length === 0) {
    let emptyTitle = 'Няма документи';
    let emptyDesc = 'Снимайте или качете документ, за да започнете.';
    if (filter || startDate || endDate) {
      emptyTitle = 'Няма намерени резултати';
      emptyDesc = 'Опитайте да промените търсенето или филтъра за период.';
    } else {
      if (state.activeTab === 'invoices') {
        emptyTitle = 'Няма запазени документи за стока';
        emptyDesc = 'Всички документи съдържащи стока ще се появят тук.';
      } else if (state.activeTab === 'bills') {
        emptyTitle = 'Няма запазени сметки';
        emptyDesc = 'Всички сметки, услуги и битови сметки ще се появят тук.';
      } else if (state.activeTab === 'receipts') {
        emptyTitle = 'Няма запазени бележки';
        emptyDesc = 'Касовите бележки се сортират автоматично тук.';
      }
    }
    
    listContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="search"></i>
        <h3>${emptyTitle}</h3>
        <p>${emptyDesc}</p>
      </div>
    `;
    elements.invoiceSummary.classList.add('hidden');
    if (elements.monthlyExpenseSummary) {
      elements.monthlyExpenseSummary.classList.add('hidden');
    }
    
    // Update pagination controls for empty list
    if (elements.pageIndicator) elements.pageIndicator.textContent = '1 / 1';
    if (elements.btnPrevPage) elements.btnPrevPage.disabled = true;
    if (elements.btnNextPage) elements.btnNextPage.disabled = true;
    
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Calculate pagination ranges
  const totalPages = Math.ceil(activeDocs.length / state.pageSize) || 1;
  if (state.currentPage > totalPages) {
    state.currentPage = totalPages;
  }
  if (state.currentPage < 1) {
    state.currentPage = 1;
  }

  // Update pagination UI elements
  if (elements.pageIndicator) {
    elements.pageIndicator.textContent = `${state.currentPage} / ${totalPages}`;
  }
  if (elements.btnPrevPage) {
    elements.btnPrevPage.disabled = state.currentPage === 1;
  }
  if (elements.btnNextPage) {
    elements.btnNextPage.disabled = state.currentPage === totalPages;
  }

  const startIndex = (state.currentPage - 1) * state.pageSize;
  const endIndex = startIndex + state.pageSize;
  const paginatedDocs = activeDocs.slice(startIndex, endIndex);

  // 3. Render active list header
  const isRevenueTab = state.activeTab === 'revenue-invoices';
  const isTaxesTab = state.activeTab === 'taxes';
  let colName = 'Доставчик';
  let colAmount = 'Сума с ДДС';
  
  if (isRevenueTab) {
    colName = 'Получател';
  } else if (isTaxesTab) {
    colName = 'Основание';
    colAmount = 'Сума';
  }
  
  const header = document.createElement('div');
  header.className = 'invoice-header' + (isTaxesTab ? ' is-taxes' : '');
  header.innerHTML = `
    <div class="invoice-col">${colName}</div>
    <div class="invoice-col">Дата</div>
    <div class="invoice-col">${colAmount}</div>
    ${isTaxesTab ? `<div class="invoice-col paid-header-col">Платено</div>` : ''}
    <div class="invoice-col" style="text-align: right;">Файлове</div>
  `;
  listContainer.appendChild(header);
  
  const listWrapper = document.createElement('div');
  listWrapper.className = 'invoice-list';
  
  let totalSum = 0;
  
  // Calculate totalSum over all matching documents (not just current page)
  activeDocs.forEach(doc => {
    if (doc.totalAmount != null) {
      totalSum += Number(doc.totalAmount);
    }
  });
  
  paginatedDocs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'invoice-item' + (!doc.image ? ' no-file' : '') + (isTaxesTab ? ' is-taxes' : '');
    item.dataset.id = doc.id;
    item.setAttribute('draggable', 'true');
    
    const mainPartyValue = isRevenueTab ? (doc.recipient || '') : (doc.supplier || '');
    const mainPartyPlaceholder = isTaxesTab ? 'Основание' : (isRevenueTab ? 'Получател' : 'Доставчик');
    const dateValue = normalizeDate(doc.date);
    const amountValue = doc.totalAmount != null ? Number(doc.totalAmount).toFixed(2) : '';
    
    const isImage = checkIsImage(doc.image);
    const linkIcon = isImage ? 'image' : 'file-text';
    const linkLabel = isImage ? 'Снимка' : 'Файл';
    
    const firstWordOfName = (mainPartyValue || '').trim().split(/\s+/)[0] || '';
    
    item.innerHTML = `
      <div class="invoice-col">
        <span class="invoice-item-text main-party-text full-name-text" title="${escapeHTML(mainPartyValue)}">${escapeHTML(mainPartyValue) || `<span class="text-muted">${mainPartyPlaceholder}</span>`}</span>
        <span class="invoice-item-text main-party-text short-name-text" title="${escapeHTML(mainPartyValue)}">${escapeHTML(firstWordOfName) || `<span class="text-muted">${mainPartyPlaceholder}</span>`}</span>
      </div>
      <div class="invoice-col date-col">
        <input type="date" class="invoice-item-input date-input" value="${dateValue}" placeholder="Дата" data-id="${doc.id}">
        <span class="invoice-item-text date-text-only">${formatDateForDisplay(dateValue) || '<span class="text-muted">Няма дата</span>'}</span>
      </div>
      <div class="invoice-col amount-col">
        <span class="invoice-item-text amount-text">${amountValue ? amountValue + ' €' : '<span class="text-muted">0.00 €</span>'}</span>
      </div>
      ${isTaxesTab ? `
      <div class="invoice-col paid-col">
        <button class="btn-paid-toggle ${doc.paid ? 'paid' : ''}" data-id="${doc.id}" title="${doc.paid ? 'Маркирай като неплатено' : 'Маркирай като платено'}">
          <i data-lucide="${doc.paid ? 'check-circle' : 'circle'}"></i>
        </button>
      </div>
      ` : ''}
      <div class="invoice-col invoice-actions">
        ${doc.image ? `
        <a class="invoice-action-link btn-view-img" data-id="${doc.id}">
          <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
        </a>
        ` : ''}
        <a class="invoice-action-link btn-row-delete text-danger" data-id="${doc.id}" title="Изтрий">
          <i data-lucide="trash-2"></i>
        </a>
      </div>
    `;
    
    // Inline edit listeners
    const dateInput = item.querySelector('.date-input');
    
    dateInput.addEventListener('click', (e) => {
      if (typeof e.target.showPicker === 'function') {
        try {
          e.target.showPicker();
        } catch (err) {}
      }
    });
    
    dateInput.addEventListener('input', (e) => {
      doc.date = e.target.value;
      localStorage.setItem('saved_documents', JSON.stringify(state.documents));
    });
    
    // Wire up clicks
    if (isTaxesTab) {
      const toggleBtn = item.querySelector('.btn-paid-toggle');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.paid = !doc.paid;
          localStorage.setItem('saved_documents', JSON.stringify(state.documents));
          renderDocumentList();
        });
      }
    }
    const btnViewImg = item.querySelector('.btn-view-img');
    if (btnViewImg) {
      btnViewImg.addEventListener('click', (e) => {
        e.stopPropagation();
        openFileInModal(doc.image, doc.name);
      });
    }
    item.querySelector('.btn-row-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete('Наистина ли искате да изтриете тази фактура?')) {
        deleteDocument(doc.id);
      }
    });
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.invoice-action-link') && !e.target.closest('.invoice-item-input')) {
        openDocDetailsModal(doc);
      }
    });
    
    listWrapper.appendChild(item);
  });
  
  listContainer.appendChild(listWrapper);
  
  // Update and show Invoice total summation bar
  elements.invoiceTotalValue.innerHTML = `${totalSum.toFixed(2)} <span class="currency-symbol">€</span>`;
  updateTodayTotal();
  elements.invoiceSummary.classList.remove('hidden');
  if (elements.monthlyExpenseSummary) {
    elements.monthlyExpenseSummary.classList.remove('hidden');
    updateMonthlyExpenseTotal();
  }
  
  if (window.lucide) window.lucide.createIcons();
}

function renderExpiringDocuments() {
  const panel = document.getElementById('panel-expiring-docs');
  const listContainer = document.getElementById('expiring-docs-list');
  const countBadge = document.getElementById('expiring-doc-count');
  if (!panel || !listContainer) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const twoWeeksLimit = new Date();
  twoWeeksLimit.setDate(today.getDate() + 14);
  twoWeeksLimit.setHours(23, 59, 59, 999);

  const expiringDocs = state.generalDocs.filter(doc => {
    if (doc.type !== 'permit' && doc.type !== 'contract') return false;
    const expiryDateVal = normalizeDate(doc.expiryDate);
    if (!expiryDateVal) return false;
    const expiry = new Date(expiryDateVal);
    if (isNaN(expiry.getTime())) return false;
    return expiry <= twoWeeksLimit;
  });

  // Sort: closest expiration first
  expiringDocs.sort((a, b) => {
    const dateA = new Date(normalizeDate(a.expiryDate));
    const dateB = new Date(normalizeDate(b.expiryDate));
    return dateA - dateB;
  });

  if (expiringDocs.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  if (countBadge) {
    countBadge.textContent = `${expiringDocs.length} Елем.`;
  }

  listContainer.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'invoice-header';
  header.style.borderTop = 'none';
  header.innerHTML = `
    <div class="invoice-col">Име на документ</div>
    <div class="invoice-col">Тип</div>
    <div class="invoice-col">Дата на изтичане</div>
    <div class="invoice-col" style="text-align: right;">Действия</div>
  `;
  listContainer.appendChild(header);

  const listWrapper = document.createElement('div');
  listWrapper.className = 'invoice-list';

  expiringDocs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'invoice-item';
    item.dataset.id = doc.id;

    const expiryDateVal = normalizeDate(doc.expiryDate);
    const isImage = checkIsImage(doc.image);
    const linkIcon = isImage ? 'image' : 'file-text';
    const linkLabel = isImage ? 'Снимка' : 'Файл';
    const typeLabel = doc.type === 'permit' ? 'Разрешително' : 'Договор';

    // Yellow warning icon alert-triangle before name
    item.innerHTML = `
      <div class="invoice-col" style="display: flex; align-items: center; gap: 0.5rem;">
        <i data-lucide="alert-triangle" style="color: #f59e0b; flex-shrink: 0; width: 16px; height: 16px;"></i>
        <span class="invoice-item-text main-party-text" title="${escapeHTML(doc.name)}">${escapeHTML(doc.name) || `<span class="text-muted">Без име</span>`}</span>
      </div>
      <div class="invoice-col">
        <span class="badge" style="font-size: 0.75rem; text-transform: uppercase; background: var(--bg-surface-hover); padding: 0.25rem 0.5rem; border-radius: 4px;">${typeLabel}</span>
      </div>
      <div class="invoice-col">
        <span style="color: #ef4444; font-weight: 500;">${formatDateForDisplay(expiryDateVal)}</span>
      </div>
      <div class="invoice-col invoice-actions">
        <a class="invoice-action-link btn-view-doc-file" data-id="${doc.id}">
          <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
        </a>
      </div>
    `;

    item.querySelector('.btn-view-doc-file').addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInModal(doc.image, doc.name);
    });

    item.addEventListener('click', (e) => {
      if (!e.target.closest('.invoice-action-link')) {
        openGeneralDocDetailsModal(doc);
      }
    });

    listWrapper.appendChild(item);
  });

  listContainer.appendChild(listWrapper);

  if (window.lucide) {
    window.lucide.createIcons({
      attrs: {
        class: 'lucide'
      },
      nameAttr: 'data-lucide'
    });
  }
}

function renderGeneralDocumentList() {
  renderExpiringDocuments();
  
  const filter = elements.searchInputDocs.value.toLowerCase().trim();
  const startDate = elements.filterStartDateDocs ? elements.filterStartDateDocs.value : '';
  const endDate = elements.filterEndDateDocs ? elements.filterEndDateDocs.value : '';
  const listContainer = elements.documentListDocs;
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  // 1. Filter docs
  const matchesFilter = (doc) => {
    const matchesText = (
      doc.name.toLowerCase().includes(filter) || 
      (doc.supplier || '').toLowerCase().includes(filter) ||
      (doc.text || '').toLowerCase().includes(filter)
    );

    const docDate = normalizeDate(doc.issueDate);
    let matchesDate = true;
    if (startDate && (!docDate || docDate < startDate)) matchesDate = false;
    if (endDate && (!docDate || docDate > endDate)) matchesDate = false;

    return matchesText && matchesDate;
  };

  const permitsList = state.generalDocs.filter(doc => 
    doc.type === 'permit' && matchesFilter(doc)
  );
  
  const contractsList = state.generalDocs.filter(doc => 
    doc.type === 'contract' && matchesFilter(doc)
  );
  
  const tradeList = state.generalDocs.filter(doc => 
    doc.type === 'trade' && matchesFilter(doc)
  );
  
  const statementList = state.generalDocs.filter(doc => 
    doc.type === 'statement' && matchesFilter(doc)
  );
  
  const otherList = state.generalDocs.filter(doc => 
    doc.type === 'other' && matchesFilter(doc)
  );
  
  // Update badges
  if (elements.badgeCountPermits) elements.badgeCountPermits.textContent = permitsList.length;
  if (elements.badgeCountContracts) elements.badgeCountContracts.textContent = contractsList.length;
  if (elements.badgeCountTrade) elements.badgeCountTrade.textContent = tradeList.length;
  if (elements.badgeCountStatement) elements.badgeCountStatement.textContent = statementList.length;
  if (elements.badgeCountGeneralOther) elements.badgeCountGeneralOther.textContent = otherList.length;
  
  // Active list
  let activeDocs = [];
  if (state.activeTabDocs === 'permit') {
    activeDocs = permitsList;
  } else if (state.activeTabDocs === 'contract') {
    activeDocs = contractsList;
  } else if (state.activeTabDocs === 'trade') {
    activeDocs = tradeList;
  } else if (state.activeTabDocs === 'statement') {
    activeDocs = statementList;
  } else {
    activeDocs = otherList;
  }
  
  // Sort: most recent first, missing dates first
  activeDocs.sort((a, b) => {
    const dateA = normalizeDate(a.issueDate);
    const dateB = normalizeDate(b.issueDate);
    if (!dateA && !dateB) return 0;
    if (!dateA) return -1;
    if (!dateB) return 1;
    return dateB.localeCompare(dateA);
  });

  if (elements.docCountDocs) {
    elements.docCountDocs.textContent = `${activeDocs.length} Елем.`;
  }
  
  if (activeDocs.length === 0) {
    let emptyTitle = 'Няма документи';
    let emptyDesc = 'Снимайте или качете документ, за да започнете.';
    if (filter || startDate || endDate) {
      emptyTitle = 'Няма намерени резултати';
      emptyDesc = 'Опитайте да промените търсенето или филтъра за период.';
    }
    
    listContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="search"></i>
        <h3>${emptyTitle}</h3>
        <p>${emptyDesc}</p>
      </div>
    `;
    
    if (elements.pageIndicatorDocs) elements.pageIndicatorDocs.textContent = '1 / 1';
    if (elements.btnPrevPageDocs) elements.btnPrevPageDocs.disabled = true;
    if (elements.btnNextPageDocs) elements.btnNextPageDocs.disabled = true;
    
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Pagination
  const totalPages = Math.ceil(activeDocs.length / state.pageSizeDocs) || 1;
  if (state.currentPageDocs > totalPages) state.currentPageDocs = totalPages;
  if (state.currentPageDocs < 1) state.currentPageDocs = 1;

  if (elements.pageIndicatorDocs) {
    elements.pageIndicatorDocs.textContent = `${state.currentPageDocs} / ${totalPages}`;
  }
  if (elements.btnPrevPageDocs) {
    elements.btnPrevPageDocs.disabled = state.currentPageDocs === 1;
  }
  if (elements.btnNextPageDocs) {
    elements.btnNextPageDocs.disabled = state.currentPageDocs === totalPages;
  }

  const startIndex = (state.currentPageDocs - 1) * state.pageSizeDocs;
  const endIndex = startIndex + state.pageSizeDocs;
  const paginatedDocs = activeDocs.slice(startIndex, endIndex);

  // Render list header
  const header = document.createElement('div');
  header.className = 'invoice-header';
  if (state.activeTabDocs === 'trade') {
    header.innerHTML = `
      <div class="invoice-col">Доставчик</div>
      <div class="invoice-col">Дата</div>
      <div class="invoice-col"></div>
      <div class="invoice-col" style="text-align: right;">Действия</div>
    `;
  } else if (state.activeTabDocs === 'statement') {
    header.innerHTML = `
      <div class="invoice-col">Банка/Институция</div>
      <div class="invoice-col">Дата</div>
      <div class="invoice-col"></div>
      <div class="invoice-col" style="text-align: right;">Действия</div>
    `;
  } else {
    header.innerHTML = `
      <div class="invoice-col">Име на документ</div>
      <div class="invoice-col">Дата издаване</div>
      <div class="invoice-col">Дата валидност</div>
      <div class="invoice-col" style="text-align: right;">Файлове</div>
    `;
  }
  listContainer.appendChild(header);
  
  const listWrapper = document.createElement('div');
  listWrapper.className = 'invoice-list';
  
  paginatedDocs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'invoice-item';
    item.dataset.id = doc.id;
    item.setAttribute('draggable', 'true');
    
    const issueDateVal = normalizeDate(doc.issueDate);
    const expiryDateVal = normalizeDate(doc.expiryDate);
    
    const isImage = checkIsImage(doc.image);
    const linkIcon = isImage ? 'image' : 'file-text';
    const linkLabel = isImage ? 'Снимка' : 'Файл';
    
    if (state.activeTabDocs === 'trade') {
      item.innerHTML = `
        <div class="invoice-col">
          <span class="invoice-item-text main-party-text" title="${escapeHTML(doc.supplier || doc.name)}">${escapeHTML(doc.supplier || doc.name) || `<span class="text-muted">Без доставчик</span>`}</span>
        </div>
        <div class="invoice-col">
          <input type="date" class="invoice-item-input issue-date-input" value="${issueDateVal}" data-id="${doc.id}">
        </div>
        <div class="invoice-col"></div>
        <div class="invoice-col invoice-actions">
          <a class="invoice-action-link btn-view-doc-file" data-id="${doc.id}">
            <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
          </a>
          <a class="invoice-action-link btn-row-delete-doc text-danger" data-id="${doc.id}" title="Изтрий">
            <i data-lucide="trash-2"></i>
          </a>
        </div>
      `;
    } else if (state.activeTabDocs === 'statement') {
      item.innerHTML = `
        <div class="invoice-col">
          <span class="invoice-item-text main-party-text" title="${escapeHTML(doc.supplier || doc.name)}">${escapeHTML(doc.supplier || doc.name) || `<span class="text-muted">Без банка/институция</span>`}</span>
        </div>
        <div class="invoice-col">
          <input type="date" class="invoice-item-input issue-date-input" value="${issueDateVal}" data-id="${doc.id}">
        </div>
        <div class="invoice-col"></div>
        <div class="invoice-col invoice-actions">
          <a class="invoice-action-link btn-view-doc-file" data-id="${doc.id}">
            <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
          </a>
          <a class="invoice-action-link btn-row-delete-doc text-danger" data-id="${doc.id}" title="Изтрий">
            <i data-lucide="trash-2"></i>
          </a>
        </div>
      `;
    } else {
      item.innerHTML = `
        <div class="invoice-col">
          <span class="invoice-item-text main-party-text" title="${escapeHTML(doc.name)}">${escapeHTML(doc.name) || `<span class="text-muted">Без име</span>`}</span>
        </div>
        <div class="invoice-col">
          <input type="date" class="invoice-item-input issue-date-input" value="${issueDateVal}" data-id="${doc.id}">
        </div>
        <div class="invoice-col">
          <input type="date" class="invoice-item-input expiry-date-input" value="${expiryDateVal}" data-id="${doc.id}">
        </div>
        <div class="invoice-col invoice-actions">
          <a class="invoice-action-link btn-view-doc-file" data-id="${doc.id}">
            <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
          </a>
          <a class="invoice-action-link btn-row-delete-doc text-danger" data-id="${doc.id}" title="Изтрий">
            <i data-lucide="trash-2"></i>
          </a>
        </div>
      `;
    }
    
    // Wire inputs
    const issueInput = item.querySelector('.issue-date-input');
    const expiryInput = item.querySelector('.expiry-date-input');
    
    [issueInput, expiryInput].forEach(inp => {
      if (inp) {
        inp.addEventListener('click', (e) => {
          if (typeof e.target.showPicker === 'function') {
            try {
              e.target.showPicker();
            } catch (err) {}
          }
        });
      }
    });
    
    if (issueInput) {
      issueInput.addEventListener('input', (e) => {
        doc.issueDate = e.target.value;
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
      });
    }
    
    if (expiryInput) {
      expiryInput.addEventListener('input', (e) => {
        doc.expiryDate = e.target.value;
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
      });
    }
    
    // Click actions
    
    item.querySelector('.btn-view-doc-file').addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInModal(doc.image, doc.name);
    });
    item.querySelector('.btn-row-delete-doc').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
        deleteGeneralDocument(doc.id);
      }
    });
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.invoice-action-link') && !e.target.closest('.invoice-item-input')) {
        openGeneralDocDetailsModal(doc);
      }
    });
    
    listWrapper.appendChild(item);
  });
  
  listContainer.appendChild(listWrapper);
  if (window.lucide) window.lucide.createIcons();
}

function renderStaffList() {
  const filter = elements.searchInputStaff.value.toLowerCase().trim();
  const listContainer = elements.staffList;
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  // Filter staff by name, position, or sub-document name
  const filteredStaff = state.staff.filter(person => {
    return person.name.toLowerCase().includes(filter) || 
           (person.position || '').toLowerCase().includes(filter) ||
           (person.documents && person.documents.some(d => d.name.toLowerCase().includes(filter)));
  });
  
  if (elements.docCountStaff) {
    elements.docCountStaff.textContent = `${filteredStaff.length} Служители`;
  }
  
  if (state.staff.length === 0 && state.unattachedStaffDocs.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="users"></i>
        <h3>Няма регистриран персонал</h3>
        <p>Натиснете бутона "Добави Служител" или качете документ, за да започнете.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  
  const activeStaff = filteredStaff.filter(p => !p.isArchived);
  const pastStaff = filteredStaff.filter(p => p.isArchived);
  
  // 1. Unattached Documents Table
  if (state.unattachedStaffDocs.length > 0) {
    const unattachedSection = document.createElement('div');
    unattachedSection.className = 'staff-section';
    unattachedSection.innerHTML = `<div class="staff-section-header-title"><i data-lucide="file-warning" class="text-warning"></i> Неприкачени документи</div>`;
    
    const unattachedListWrapper = document.createElement('div');
    unattachedListWrapper.className = 'staff-sub-list';
    
    const unattachedHeader = document.createElement('div');
    unattachedHeader.className = 'staff-table-header unattached-staff-header';
    unattachedHeader.innerHTML = `
      <div class="staff-header-col">Документ</div>
      <div class="staff-header-col">Извлечено име</div>
      <div class="staff-header-col">Прикачи към</div>
      <div class="staff-header-col" style="text-align: right;">Действия</div>
    `;
    unattachedListWrapper.appendChild(unattachedHeader);
    
    const activeStaffOptions = state.staff
      .filter(p => !p.isArchived)
      .map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`)
      .join('');
      
    state.unattachedStaffDocs.forEach(doc => {
      const item = document.createElement('div');
      item.className = 'staff-table-item unattached-staff-item';
      item.dataset.id = doc.id;
      
      const extName = doc.extractedName || 'Неизвестен';
      const extPosition = doc.extractedPosition || '';
      
      let selectOptions = `<option value="">-- Изберете служител --</option>`;
      if (doc.extractedName) {
        selectOptions += `<option value="new_extracted">Създай нов: "${escapeHTML(doc.extractedName)}"</option>`;
      }
      selectOptions += `<option value="new_custom">Създай нов (въведи име)...</option>`;
      if (activeStaffOptions) {
        selectOptions += `<optgroup label="Активни служители">${activeStaffOptions}</optgroup>`;
      }
      
      item.innerHTML = `
        <div class="staff-table-row unattached-staff-row">
          <div class="staff-table-col font-semibold text-primary" title="${escapeHTML(doc.name)}">
            <i data-lucide="file-text" class="text-muted" style="display:inline-block; vertical-align:middle; margin-right:4px;"></i>
            ${escapeHTML(doc.name)}
            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal; margin-left: 20px;">Качен на: ${formatDateForDisplay(doc.uploadDate)}</div>
          </div>
          <div class="staff-table-col text-secondary" title="${escapeHTML(extName)}">
            ${escapeHTML(extName)}
            ${extPosition ? `<div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(extPosition)}</div>` : ''}
          </div>
          <div class="staff-table-col" style="display: flex; gap: 0.25rem; align-items: center; overflow: visible;">
            <select class="staff-inline-select select-attach" data-id="${doc.id}" style="max-width: 180px; font-size: 0.8rem; padding: 0.2rem; border-radius: var(--radius-sm); background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary);">
              ${selectOptions}
            </select>
            <button class="btn btn-xs btn-primary btn-attach-doc" data-id="${doc.id}" title="Прикачи">
              <i data-lucide="check"></i>
            </button>
          </div>
          <div class="staff-table-col staff-row-actions">
            <button class="btn btn-xs btn-danger-text btn-delete-unattached text-danger" data-id="${doc.id}" title="Изтрий документ">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      `;
      
      const selectEl = item.querySelector('.select-attach');
      const attachBtn = item.querySelector('.btn-attach-doc');
      const deleteBtn = item.querySelector('.btn-delete-unattached');
      
      attachBtn.addEventListener('click', () => {
        const val = selectEl.value;
        if (!val) {
          showToast('Моля, изберете опция за прикачване.', 'alert-triangle');
          return;
        }
        attachUnattachedDoc(doc.id, val);
      });
      
      deleteBtn.addEventListener('click', () => {
        deleteUnattachedDoc(doc.id);
      });
      
      unattachedListWrapper.appendChild(item);
    });
    
    unattachedSection.appendChild(unattachedListWrapper);
    listContainer.appendChild(unattachedSection);
  }
  
  // 2. Active Staff Table
  if (state.staff.length > 0) {
    const activeSection = document.createElement('div');
    activeSection.className = 'staff-section';
    if (state.unattachedStaffDocs.length > 0) {
      activeSection.style.marginTop = '2rem';
    }
    activeSection.innerHTML = `<div class="staff-section-header-title"><i data-lucide="user-check" class="text-accent"></i> Активни служители</div>`;
    
    const activeListWrapper = document.createElement('div');
    activeListWrapper.className = 'staff-sub-list';
    
    if (activeStaff.length === 0) {
      activeListWrapper.innerHTML = `<div class="empty-sub-state">Няма активни служители по зададените критерии.</div>`;
    } else {
      const activeHeader = document.createElement('div');
      activeHeader.className = 'staff-table-header';
      activeHeader.innerHTML = `
        <div class="staff-header-col">Име</div>
        <div class="staff-header-col">Длъжност</div>
        <div class="staff-header-col">Назначен на</div>
        <div class="staff-header-col" style="text-align: right;">Действия</div>
      `;
      activeListWrapper.appendChild(activeHeader);
      
      activeStaff.forEach(person => {
        const item = document.createElement('div');
        item.className = 'staff-table-item';
        item.dataset.id = person.id;
        
        const hiringDateVal = normalizeDate(person.hiringDate);
        const positionVal = person.position || 'Неизвестна';
        const docCount = person.documents ? person.documents.length : 0;
        
        item.innerHTML = `
          <div class="staff-table-row">
            <div class="staff-table-col font-semibold text-primary" style="overflow: visible;">
              <input type="text" class="invoice-item-input staff-inline-name-input font-semibold text-primary" value="${escapeHTML(person.name)}" data-id="${person.id}" title="${escapeHTML(person.name)}" style="width: 100%; padding: 0.2rem 0.4rem;">
            </div>
            <div class="staff-table-col text-secondary" style="overflow: visible;">
              <input type="text" class="invoice-item-input staff-inline-position-input text-secondary" value="${escapeHTML(person.position || '')}" placeholder="Неизвестна" data-id="${person.id}" title="${escapeHTML(person.position || 'Неизвестна')}" style="width: 100%; padding: 0.2rem 0.4rem;">
            </div>
            <div class="staff-table-col">
              <input type="date" class="staff-inline-date-input date-hiring" value="${hiringDateVal}" data-id="${person.id}">
            </div>
            <div class="staff-table-col staff-row-actions">
              <button class="btn btn-xs btn-secondary btn-toggle-files" data-id="${person.id}">
                <i data-lucide="folder-open"></i> Файлове (${docCount})
              </button>
              <button class="btn btn-xs btn-secondary btn-archive-staff" data-id="${person.id}" title="Освободи служител">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          </div>
          <div class="staff-files-panel hidden">
            <div class="staff-docs-list"></div>
          </div>
        `;
        setupStaffItemEvents(item, person);
        activeListWrapper.appendChild(item);
      });
    }
    activeSection.appendChild(activeListWrapper);
    listContainer.appendChild(activeSection);
  }
  
  // 2. Past Staff Table
  const pastSection = document.createElement('div');
  pastSection.className = 'staff-section';
  pastSection.style.marginTop = '2rem';
  pastSection.innerHTML = `<div class="staff-section-header-title"><i data-lucide="user-x" class="text-muted"></i> Бивши служители</div>`;
  
  const pastListWrapper = document.createElement('div');
  pastListWrapper.className = 'staff-sub-list';
  
  if (pastStaff.length === 0) {
    pastListWrapper.innerHTML = `<div class="empty-sub-state">Няма бивши служители по зададените критерии.</div>`;
  } else {
    const pastHeader = document.createElement('div');
    pastHeader.className = 'staff-table-header past-staff-header';
    pastHeader.innerHTML = `
      <div class="staff-header-col">Име</div>
      <div class="staff-header-col">Длъжност</div>
      <div class="staff-header-col">Освободен на</div>
      <div class="staff-header-col" style="text-align: right;">Действия</div>
    `;
    pastListWrapper.appendChild(pastHeader);
    
    pastStaff.forEach(person => {
      const item = document.createElement('div');
      item.className = 'staff-table-item past-staff-item';
      item.dataset.id = person.id;
      
      const archiveDateVal = normalizeDate(person.archiveDate) || new Date().toISOString().slice(0, 10);
      const positionVal = person.position || 'Неизвестна';
      const docCount = person.documents ? person.documents.length : 0;
      
      item.innerHTML = `
        <div class="staff-table-row past-staff-row">
          <div class="staff-table-col text-muted" style="overflow: visible;">
            <input type="text" class="invoice-item-input staff-inline-name-input text-muted" value="${escapeHTML(person.name)}" data-id="${person.id}" title="${escapeHTML(person.name)}" style="width: 100%; padding: 0.2rem 0.4rem;">
          </div>
          <div class="staff-table-col text-muted" style="overflow: visible;">
            <input type="text" class="invoice-item-input staff-inline-position-input text-muted" value="${escapeHTML(person.position || '')}" placeholder="Неизвестна" data-id="${person.id}" title="${escapeHTML(person.position || 'Неизвестна')}" style="width: 100%; padding: 0.2rem 0.4rem;">
          </div>
          <div class="staff-table-col">
            <input type="date" class="staff-inline-date-input date-archive" value="${archiveDateVal}" data-id="${person.id}">
          </div>
          <div class="staff-table-col staff-row-actions">
            <button class="btn btn-xs btn-secondary btn-toggle-files" data-id="${person.id}">
              <i data-lucide="folder-open"></i> Файлове (${docCount})
            </button>
            <button class="btn btn-xs btn-secondary btn-restore-staff" data-id="${person.id}" title="Възстанови в активни / Restore to active">
              <i data-lucide="rotate-ccw"></i>
            </button>
            <button class="btn btn-xs btn-danger-text btn-delete-staff text-danger" data-id="${person.id}" title="Изтрий служител">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
        <div class="staff-files-panel hidden">
          <div class="staff-docs-list"></div>
        </div>
      `;
      setupStaffItemEvents(item, person);
      pastListWrapper.appendChild(item);
    });
  }
  pastSection.appendChild(pastListWrapper);
  listContainer.appendChild(pastSection);
  
  if (window.lucide) window.lucide.createIcons();
}

function setupStaffItemEvents(item, person) {
  const nameInput = item.querySelector('.staff-inline-name-input');
  const positionInput = item.querySelector('.staff-inline-position-input');
  const hiringInput = item.querySelector('.date-hiring');
  const archiveInput = item.querySelector('.date-archive');
  const toggleFilesBtn = item.querySelector('.btn-toggle-files');
  const archiveBtn = item.querySelector('.btn-archive-staff');
  const deleteBtn = item.querySelector('.btn-delete-staff');
  const restoreBtn = item.querySelector('.btn-restore-staff');
  const filesPanel = item.querySelector('.staff-files-panel');
  const docsList = item.querySelector('.staff-docs-list');
  
  if (nameInput) {
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    nameInput.addEventListener('change', (e) => {
      const val = e.target.value.trim();
      if (!val) {
        showToast('Името не може да бъде празно.', 'alert-triangle');
        e.target.value = person.name;
        return;
      }
      person.name = val;
      e.target.title = val;
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
      renderStaffList();
    });
  }
  
  if (positionInput) {
    positionInput.addEventListener('click', (e) => e.stopPropagation());
    positionInput.addEventListener('change', (e) => {
      const val = e.target.value.trim();
      person.position = val;
      e.target.title = val || 'Неизвестна';
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
      renderStaffList();
    });
  }
  
  if (hiringInput) {
    hiringInput.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof e.target.showPicker === 'function') {
        try { e.target.showPicker(); } catch (err) {}
      }
    });
    hiringInput.addEventListener('input', (e) => {
      person.hiringDate = e.target.value;
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    });
  }
  
  if (archiveInput) {
    archiveInput.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof e.target.showPicker === 'function') {
        try { e.target.showPicker(); } catch (err) {}
      }
    });
    archiveInput.addEventListener('input', (e) => {
      person.archiveDate = e.target.value;
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    });
  }
  
  if (toggleFilesBtn) {
    toggleFilesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = filesPanel.classList.contains('hidden');
      if (isHidden) {
        renderStaffPersonDocs(person, docsList);
        filesPanel.classList.remove('hidden');
        toggleFilesBtn.classList.add('active');
      } else {
        filesPanel.classList.add('hidden');
        toggleFilesBtn.classList.remove('active');
      }
    });
  }
  
  if (archiveBtn) {
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const archiveDate = prompt("Моля, въведете дата на освобождаване (ГГГГ-ММ-ДД) или натиснете OK за днес:", new Date().toISOString().slice(0, 10));
      if (archiveDate !== null) {
        person.isArchived = true;
        person.archiveDate = normalizeDate(archiveDate) || new Date().toISOString().slice(0, 10);
        localStorage.setItem('saved_staff', JSON.stringify(state.staff));
        renderStaffList();
        showToast('Служителят е архивиран.', 'archive');
      }
    });
  }
  
  if (restoreBtn) {
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Наистина ли искате да възстановите служителя ${person.name} като активен?`)) {
        person.isArchived = false;
        person.archiveDate = null;
        localStorage.setItem('saved_staff', JSON.stringify(state.staff));
        renderStaffList();
        showToast('Служителят е възстановен като активен.', 'user-check');
      }
    });
  }
  
  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete(`Наистина ли искате да изтриете служителя ${person.name} и всички негови документи?`)) {
        deleteStaffPerson(person.id);
      }
    });
  }
}

function renderStaffGeneralDocsList() {
  const listContainer = document.getElementById('staff-general-docs-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  // Filter by active tab (payroll, schedule, other)
  const activeTab = state.activeTabStaffGen || 'payroll';
  
  const filteredDocs = state.staffGeneralDocs.filter(doc => doc.type === activeTab);
  
  // Update badges
  const payrollCount = state.staffGeneralDocs.filter(doc => doc.type === 'payroll').length;
  const scheduleCount = state.staffGeneralDocs.filter(doc => doc.type === 'schedule').length;
  const otherCount = state.staffGeneralDocs.filter(doc => doc.type === 'other').length;
  
  if (elements.badgeCountPayroll) elements.badgeCountPayroll.textContent = payrollCount;
  if (elements.badgeCountSchedule) elements.badgeCountSchedule.textContent = scheduleCount;
  if (elements.badgeCountStaffOther) elements.badgeCountStaffOther.textContent = otherCount;
  
  if (elements.staffGeneralDocsCount) {
    elements.staffGeneralDocsCount.textContent = `${filteredDocs.length} Елем.`;
  }
  
  if (filteredDocs.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state" style="padding: 2rem 1rem;">
        <i data-lucide="inbox"></i>
        <h3>Няма документи</h3>
        <p>Снимайте или качете документ на служител, за да се появи тук.</p>
      </div>
    `;
    if (elements.pageIndicatorStaffGen) elements.pageIndicatorStaffGen.textContent = '1 / 1';
    if (elements.btnPrevPageStaffGen) elements.btnPrevPageStaffGen.disabled = true;
    if (elements.btnNextPageStaffGen) elements.btnNextPageStaffGen.disabled = true;
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  
  // Pagination
  const totalPages = Math.ceil(filteredDocs.length / state.pageSizeStaffGen) || 1;
  if (state.currentPageStaffGen > totalPages) state.currentPageStaffGen = totalPages;
  if (state.currentPageStaffGen < 1) state.currentPageStaffGen = 1;
  
  if (elements.pageIndicatorStaffGen) {
    elements.pageIndicatorStaffGen.textContent = `${state.currentPageStaffGen} / ${totalPages}`;
  }
  if (elements.btnPrevPageStaffGen) {
    elements.btnPrevPageStaffGen.disabled = state.currentPageStaffGen === 1;
  }
  if (elements.btnNextPageStaffGen) {
    elements.btnNextPageStaffGen.disabled = state.currentPageStaffGen === totalPages;
  }
  
  const startIndex = (state.currentPageStaffGen - 1) * state.pageSizeStaffGen;
  const endIndex = startIndex + state.pageSizeStaffGen;
  const paginatedDocs = filteredDocs.slice(startIndex, endIndex);
  
  // Generate employee options dynamically
  const activeStaffOptions = state.staff
    .filter(p => !p.isArchived)
    .map(p => `<option value="person_${p.id}">${escapeHTML(p.name)}</option>`)
    .join('');
  
  // Render header row
  const header = document.createElement('div');
  header.className = 'invoice-header';
  header.innerHTML = `
    <div class="invoice-col">Име</div>
    <div class="invoice-col">Дата</div>
    <div class="invoice-col">Премести в...</div>
    <div class="invoice-col" style="text-align: right;">Действия</div>
  `;
  listContainer.appendChild(header);
  
  const listWrapper = document.createElement('div');
  listWrapper.className = 'invoice-list';
  
  paginatedDocs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'invoice-item';
    item.dataset.id = doc.id;
    
    const docDateVal = normalizeDate(doc.date) || new Date().toISOString().slice(0, 10);
    const isImage = checkIsImage(doc.image);
    const linkIcon = isImage ? 'image' : 'file-text';
    const linkLabel = isImage ? 'Снимка' : 'Файл';
    
    item.innerHTML = `
      <div class="invoice-col">
        <input type="text" class="invoice-item-input staff-gen-name-input" value="${escapeHTML(doc.name)}" data-id="${doc.id}">
      </div>
      <div class="invoice-col">
        <input type="date" class="invoice-item-input staff-gen-date-input" value="${docDateVal}" data-id="${doc.id}">
      </div>
      <div class="invoice-col">
        <select class="staff-inline-select select-move-doc" data-id="${doc.id}" style="width: 100%; font-size: 0.8rem; padding: 0.25rem; border-radius: var(--radius-sm); background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary); cursor: pointer;">
          <option value="">-- Премести в... --</option>
          <optgroup label="Файлове на служител">
            ${activeStaffOptions}
          </optgroup>
          <optgroup label="Друга категория">
            <option value="cat_payroll">Ведомости</option>
            <option value="cat_schedule">Графици</option>
            <option value="cat_other">Други</option>
          </optgroup>
        </select>
      </div>
      <div class="invoice-col invoice-actions">
        <a class="invoice-action-link btn-view-staff-gen-file" data-id="${doc.id}">
          <i data-lucide="${linkIcon}"></i> <span class="btn-text">${linkLabel}</span>
        </a>
        <a class="invoice-action-link btn-delete-staff-gen text-danger" data-id="${doc.id}" title="Изтрий">
          <i data-lucide="trash-2"></i>
        </a>
      </div>
    `;
    
    // Bind inline editing of name
    const nameInput = item.querySelector('.staff-gen-name-input');
    nameInput.addEventListener('change', (e) => {
      doc.name = e.target.value.trim() || 'Документ';
      localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));
    });
    
    // Bind inline editing of date
    const dateInput = item.querySelector('.staff-gen-date-input');
    dateInput.addEventListener('click', (e) => {
      if (typeof e.target.showPicker === 'function') {
        try { e.target.showPicker(); } catch (err) {}
      }
    });
    dateInput.addEventListener('change', (e) => {
      doc.date = e.target.value;
      localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));
    });
    
    // Bind move select dropdown
    const moveSelect = item.querySelector('.select-move-doc');
    moveSelect.addEventListener('change', (e) => {
      const targetOption = e.target.value;
      if (targetOption) {
        const optionText = e.target.options[e.target.selectedIndex].text;
        if (confirm(`Наистина ли искате да преместите този документ в "${optionText}"?`)) {
          moveStaffGeneralDoc(doc.id, targetOption);
        } else {
          e.target.value = '';
        }
      }
    });
    
    // View file action
    item.querySelector('.btn-view-staff-gen-file').addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInModal(doc.image, doc.name);
    });
    
    // Delete action
    item.querySelector('.btn-delete-staff-gen').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
        deleteStaffGeneralDocument(doc.id);
      }
    });
    
    listWrapper.appendChild(item);
  });
  
  listContainer.appendChild(listWrapper);
  if (window.lucide) window.lucide.createIcons();
}

function deleteStaffGeneralDocument(id) {
  const target = state.staffGeneralDocs.find(doc => doc.id === id);
  if (target) deleteFileFromServer(target.image);
  state.staffGeneralDocs = state.staffGeneralDocs.filter(doc => doc.id !== id);
  try {
    localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));
  } catch (e) {
    console.error('Storage error', e);
  }
  renderStaffGeneralDocsList();
  showToast('Документът е изтрит.', 'trash');
}

function moveStaffGeneralDoc(docId, targetOption) {
  if (!targetOption) return;

  const docIndex = state.staffGeneralDocs.findIndex(d => d.id === docId);
  if (docIndex === -1) {
    showToast('Документът не беше намерен.', 'alert-triangle');
    return;
  }
  const doc = state.staffGeneralDocs[docIndex];

  // 1. Move to employee folder
  if (targetOption.startsWith('person_')) {
    const personId = targetOption.replace('person_', '');
    const employee = state.staff.find(p => p.id === personId);
    if (!employee) {
      showToast('Служителят не беше намерен.', 'alert-triangle');
      return;
    }
    
    // Construct sub-document object
    const subDoc = {
      id: 'sdoc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: doc.name,
      image: doc.image,
      uploadDate: doc.date || new Date().toISOString().slice(0, 10),
      fullText: ''
    };

    if (!employee.documents) employee.documents = [];
    employee.documents.unshift(subDoc);

    // Remove from staff general documents
    state.staffGeneralDocs.splice(docIndex, 1);

    // Save states
    localStorage.setItem('saved_staff', JSON.stringify(state.staff));
    localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));

    // Refresh views
    renderStaffGeneralDocsList();
    renderStaffList();
    showToast(`Документът е преместен в досието на ${employee.name}.`, 'check-circle');
  }
  // 2. Move to other category within the current general staff documents panel
  else if (targetOption.startsWith('cat_')) {
    const category = targetOption.replace('cat_', '');
    
    // Update the category (type) of the document
    doc.type = category; // 'payroll', 'schedule', or 'other'

    // Save state
    localStorage.setItem('saved_staff_general_documents', JSON.stringify(state.staffGeneralDocs));

    // Refresh views
    renderStaffGeneralDocsList();
    showToast('Документът е преместен.', 'check-circle');
  }
}

function renderStaffPersonDocs(person, docsList) {
  docsList.innerHTML = '';
  if (!person.documents || person.documents.length === 0) {
    docsList.innerHTML = `<div class="empty-sub-state">Няма добавени документи за този служител.</div>`;
    return;
  }
  
  person.documents.forEach(doc => {
    const docRow = document.createElement('div');
    docRow.className = 'staff-doc-row';
    docRow.dataset.id = doc.id;
    
    const isImage = checkIsImage(doc.image);
    const linkIcon = isImage ? 'image' : 'file-text';
    const uploadDateFormatted = normalizeDate(doc.uploadDate);
    
    docRow.innerHTML = `
      <div class="staff-doc-title">
        <i data-lucide="file-text" class="sub-doc-icon"></i>
        <input type="text" class="staff-doc-name-input" value="${escapeHTML(doc.name)}" title="Преименувай документа" data-doc-id="${doc.id}" data-person-id="${person.id}">
      </div>
      <div class="staff-doc-meta">Качен на: ${formatDateForDisplay(uploadDateFormatted)}</div>
      <div class="staff-doc-actions">
        <button class="btn btn-xs btn-secondary btn-view-staff-doc-details" data-doc-id="${doc.id}" data-person-id="${person.id}" title="Детайли">
          <i data-lucide="file-text"></i> Детайли
        </button>
        <button class="btn btn-xs btn-secondary btn-view-staff-doc-file" data-doc-id="${doc.id}" title="Виж файла">
          <i data-lucide="${linkIcon}"></i>
        </button>
        <button class="btn btn-xs btn-secondary btn-delete-staff-doc text-danger" data-doc-id="${doc.id}" data-person-id="${person.id}" title="Изтрий документа">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;
    
    // Editable name input
    const nameInput = docRow.querySelector('.staff-doc-name-input');
    nameInput.addEventListener('change', (e) => {
      e.stopPropagation();
      const newName = e.target.value.trim();
      if (newName && newName !== doc.name) {
        doc.name = newName;
        localStorage.setItem('saved_staff', JSON.stringify(state.staff));
      } else if (!newName) {
        e.target.value = doc.name; // revert if empty
      }
    });
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.target.blur();
      }
    });
    
    docRow.querySelector('.btn-view-staff-doc-details').addEventListener('click', (e) => {
      e.stopPropagation();
      openStaffDocDetailsModal(person, doc);
    });
    
    docRow.querySelector('.btn-view-staff-doc-file').addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInModal(doc.image, doc.name);
    });
    
    docRow.querySelector('.btn-delete-staff-doc').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
        deleteStaffDocument(person.id, doc.id);
        renderStaffPersonDocs(person, docsList);
        renderStaffList();
      }
    });
    
    docsList.appendChild(docRow);
  });
  if (window.lucide) window.lucide.createIcons();
}

function openGeneralDocDetailsModal(doc) {
  state.currentlyViewingDocIdDocs = doc.id;
  
  const labelElem = document.getElementById('label-view-doc-name');
  if (doc.type === 'trade') {
    if (labelElem) labelElem.textContent = 'Доставчик / Supplier';
    elements.viewDocName.placeholder = 'Доставчик...';
    elements.viewDocName.value = doc.supplier || doc.name || '';
  } else if (doc.type === 'statement') {
    if (labelElem) labelElem.textContent = 'Банка/Институция / Bank/Institution';
    elements.viewDocName.placeholder = 'Банка/Институция...';
    elements.viewDocName.value = doc.supplier || doc.name || '';
  } else {
    if (labelElem) labelElem.textContent = 'Име на документа / Document Name';
    elements.viewDocName.placeholder = 'Договор, Разрешително...';
    elements.viewDocName.value = doc.name || '';
  }
  
  elements.viewDocIssueDate.value = normalizeDate(doc.issueDate);
  if (elements.viewDocExpiryDate) {
    elements.viewDocExpiryDate.value = normalizeDate(doc.expiryDate);
  }
  elements.viewDocCategory.value = doc.type || 'other';
  elements.viewDocText.value = doc.text || '';
  
  if (doc.type === 'trade') {
    if (elements.containerViewDocText) elements.containerViewDocText.classList.add('hidden');
    if (elements.containerViewDocProducts) elements.containerViewDocProducts.classList.remove('hidden');
    renderGeneralDocProducts(doc);
  } else {
    if (elements.containerViewDocText) elements.containerViewDocText.classList.remove('hidden');
    if (elements.containerViewDocProducts) elements.containerViewDocProducts.classList.add('hidden');
  }
  
  const isImage = checkIsImage(doc.image);
  
  if (isImage) {
    elements.modalDocPreviewImg.src = doc.image;
    elements.modalDocPreviewImg.classList.remove('hidden');
    elements.modalDocPreviewPlaceholder.classList.add('hidden');
  } else {
    elements.modalDocPreviewImg.src = '';
    elements.modalDocPreviewImg.classList.add('hidden');
    elements.modalDocPreviewPlaceholder.classList.remove('hidden');
    
    const iconName = getIconForMime(doc.image);
    const iconElem = elements.modalDocPreviewPlaceholder.querySelector('i');
    if (iconElem) {
      iconElem.setAttribute('data-lucide', iconName);
    }
    const nameElem = elements.modalDocPreviewPlaceholder.querySelector('.placeholder-filename');
    if (nameElem) {
      nameElem.textContent = doc.name;
    }
  }
  
  const dateStr = new Date(doc.timestamp).toLocaleString('bg-BG');
  elements.viewDocSavedDate.textContent = `Записан на: ${dateStr}`;
  
  openModal(elements.modalDocDetails);
  if (window.lucide) window.lucide.createIcons();
}

function renderGeneralDocProducts(doc) {
  const container = elements.modalDocProductsBody;
  if (!container) return;
  container.innerHTML = '';
  
  doc.products = doc.products || [];
  
  if (doc.products.length === 0) {
    container.innerHTML = `
      <tr class="empty-products-row">
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem 0;">
          Няма добавени продукти. Натиснете "Добави продукт", за да започнете.
        </td>
      </tr>
    `;
    return;
  }
  
  doc.products.forEach((p, idx) => {
    const row = document.createElement('tr');
    
    const prodName = p.product || '';
    const prodBatch = p.batch || '';
    const prodExpiry = p.expiry || '';
    
    row.innerHTML = `
      <td>
        <input type="text" class="products-table-input product-name-input" value="${escapeHTML(prodName)}" placeholder="Продукт...">
      </td>
      <td>
        <input type="text" class="products-table-input product-batch-input" value="${escapeHTML(prodBatch)}" placeholder="Партида...">
      </td>
      <td>
        <input type="date" class="products-table-input product-expiry-input" value="${prodExpiry}">
      </td>
      <td style="text-align: center;">
        <button type="button" class="btn-row-delete-product text-danger" style="background: none; border: none; cursor: pointer; padding: 0.25rem;" title="Изтрий продукт">
          <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
        </button>
      </td>
    `;
    
    const nameInp = row.querySelector('.product-name-input');
    const batchInp = row.querySelector('.product-batch-input');
    const expiryInp = row.querySelector('.product-expiry-input');
    const deleteBtn = row.querySelector('.btn-row-delete-product');
    
    nameInp.addEventListener('input', (e) => {
      p.product = e.target.value;
      localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
    });
    
    batchInp.addEventListener('input', (e) => {
      p.batch = e.target.value;
      localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
    });
    
    expiryInp.addEventListener('input', (e) => {
      p.expiry = e.target.value;
      localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
    });
    
    expiryInp.addEventListener('click', (e) => {
      if (typeof e.target.showPicker === 'function') {
        try {
          e.target.showPicker();
        } catch (err) {}
      }
    });
    
    deleteBtn.addEventListener('click', () => {
      doc.products.splice(idx, 1);
      localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
      renderGeneralDocProducts(doc);
    });
    
    container.appendChild(row);
  });
  
  if (window.lucide) window.lucide.createIcons();
}

function openStaffDocDetailsModal(person, doc) {
  state.currentlyViewingStaffPersonId = person.id;
  state.currentlyViewingStaffDocId = doc.id;
  
  elements.viewStaffDocName.value = doc.name || '';
  elements.viewStaffDocUploadDate.value = normalizeDate(doc.uploadDate);
  elements.viewStaffDocText.value = doc.fullText || '';
  
  openModal(elements.modalStaffDocDetails);
}

// Sums totalAmount of all expense entries (Стока, Сметки, Бележки, Данъци, Други)
// dated today, regardless of the active tab or search/date filters.
function updateTodayTotal() {
  if (!elements.invoiceTodayValue) return;

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const expenseTypes = ['invoice', 'bills', 'receipt', 'taxes', 'other'];

  let todaySum = 0;
  state.documents.forEach(doc => {
    if (!expenseTypes.includes(doc.type)) return;
    if (normalizeDate(doc.date) !== todayStr) return;
    if (doc.totalAmount != null) {
      todaySum += Number(doc.totalAmount);
    }
  });

  elements.invoiceTodayValue.innerHTML = `${todaySum.toFixed(2)} <span class="currency-symbol">€</span>`;
}

function recalculateInvoiceTotal() {
  const filter = elements.searchInput.value.toLowerCase().trim();
  const startDate = elements.filterStartDate ? elements.filterStartDate.value : '';
  const endDate = elements.filterEndDate ? elements.filterEndDate.value : '';
  
  const tabToType = {
    'invoices': 'invoice',
    'bills': 'bills',
    'revenue-invoices': 'revenue-invoice',
    'receipts': 'receipt',
    'taxes': 'taxes',
    'other': 'other'
  };
  const expectedType = tabToType[state.activeTab];
  
  const activeList = state.documents.filter(doc => {
    if (doc.type !== expectedType) return false;
    
    const matchesText = (
      doc.name.toLowerCase().includes(filter) || 
      (doc.transcription || '').toLowerCase().includes(filter) ||
      (doc.supplier && doc.supplier.toLowerCase().includes(filter)) ||
      (doc.recipient && doc.recipient.toLowerCase().includes(filter)) ||
      (doc.products && doc.products.some(p => p.name && p.name.toLowerCase().includes(filter)))
    );

    const docDate = normalizeDate(doc.date);
    let matchesDate = true;
    if (startDate && (!docDate || docDate < startDate)) matchesDate = false;
    if (endDate && (!docDate || docDate > endDate)) matchesDate = false;

    return matchesText && matchesDate;
  });
  
  let totalSum = 0;
  activeList.forEach(d => {
    if (d.totalAmount != null) {
      totalSum += Number(d.totalAmount);
    }
  });

  elements.invoiceTotalValue.innerHTML = `${totalSum.toFixed(2)} <span class="currency-symbol">€</span>`;
  updateTodayTotal();
}

// ==========================================
// Modal Controllers
// ==========================================

function openModal(modalElement) {
  modalElement.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Lock scroll
}

function closeModal(modalElement) {
  modalElement.classList.add('hidden');
  document.body.style.overflow = ''; // Unlock scroll
  
  // If closing details modal, reset viewing ID
  if (modalElement === elements.modalView) {
    state.currentlyViewingDocId = null;
  }
  if (modalElement === elements.modalDocDetails) {
    state.currentlyViewingDocIdDocs = null;
  }
  if (modalElement === elements.modalStaffDocDetails) {
    state.currentlyViewingStaffPersonId = null;
    state.currentlyViewingStaffDocId = null;
  }
  
  // Reset elements and revoke Blob URL when closing lightbox
  if (modalElement === elements.modalImage) {
    const iframe = document.getElementById('lightbox-iframe');
    if (iframe) iframe.src = '';
    
    if (activeLightboxBlobUrl) {
      URL.revokeObjectURL(activeLightboxBlobUrl);
      activeLightboxBlobUrl = null;
    }
  }
}

function openDocDetailsModal(doc) {
  state.currentlyViewingDocId = doc.id;
  elements.viewTitle.textContent = doc.name;
  
  // Clean up any existing placeholder in details modal
  const existingModalPlaceholder = document.getElementById('modal-doc-placeholder');
  if (existingModalPlaceholder) {
    existingModalPlaceholder.remove();
  }
  
  const isImage = checkIsImage(doc.image);
  
  if (doc.image) {
    elements.btnViewExpand.classList.remove('hidden');
  } else {
    elements.btnViewExpand.classList.add('hidden');
  }
  
  if (isImage) {
    elements.viewImgPreview.src = doc.image;
    elements.viewImgPreview.classList.remove('hidden');
    elements.btnViewExpand.innerHTML = `<i data-lucide="maximize-2"></i> View Full Size`;
  } else {
    elements.viewImgPreview.src = '';
    elements.viewImgPreview.classList.add('hidden');
    elements.btnViewExpand.innerHTML = `<i data-lucide="maximize-2"></i> View File`;
    
    // Create detailed modal file placeholder
    const placeholder = document.createElement('div');
    placeholder.id = 'modal-doc-placeholder';
    placeholder.className = 'document-preview-placeholder';
    placeholder.style.height = '80%';
    placeholder.style.border = 'none';
    placeholder.style.background = 'transparent';
    
    const iconName = doc.image ? getIconForMime(doc.image) : 'file-x';
    const placeholderText = doc.image ? escapeHTML(doc.name) : 'Няма прикачен файл';
    
    placeholder.innerHTML = `
      <div class="doc-placeholder-icon" style="width: 80px; height: 80px; margin-bottom: 0.5rem;">
        <i data-lucide="${iconName}" style="width: 40px; height: 40px;"></i>
      </div>
      <div class="doc-placeholder-info">
        <div class="doc-placeholder-name" style="font-size: 1.1rem; font-weight: 500; color: var(--text-primary); text-align: center;">${placeholderText}</div>
      </div>
    `;
    
    const viewImagePane = document.querySelector('.view-image-pane');
    viewImagePane.insertBefore(placeholder, elements.btnViewExpand);
  }
  
  // Populate form controls
  const supplierInput = document.getElementById('view-supplier');
  const recipientInput = document.getElementById('view-recipient');
  const dateInput = document.getElementById('view-date-input');
  const amountInput = document.getElementById('view-amount');
  
  supplierInput.value = doc.supplier || '';
  recipientInput.value = doc.recipient || '';
  dateInput.value = normalizeDate(doc.date);
  amountInput.value = doc.totalAmount != null ? doc.totalAmount : '';
  
  // Populate category dropdown
  const categorySelect = document.getElementById('view-category');
  categorySelect.value = doc.type || 'other';
  
  // Dynamic UI adjustment for taxes
  const isTaxes = (doc.type === 'taxes');
  const supplierLabel = supplierInput.closest('.input-group-modal').querySelector('label');
  if (supplierLabel) {
    supplierLabel.textContent = isTaxes ? 'Основание / Grounds' : 'Доставчик / Supplier';
  }
  const recipientGroup = recipientInput.closest('.input-group-modal');
  if (recipientGroup) {
    if (isTaxes) {
      recipientGroup.classList.add('hidden');
    } else {
      recipientGroup.classList.remove('hidden');
    }
  }
  const productsGroup = document.getElementById('btn-add-product').closest('.input-group-modal');
  if (productsGroup) {
    if (isTaxes) {
      productsGroup.classList.add('hidden');
    } else {
      productsGroup.classList.remove('hidden');
    }
  }
  
  renderModalProductsTable(doc);
  
  const dateStr = new Date(doc.timestamp).toLocaleString('bg-BG');
  elements.viewDate.textContent = `Записан на: ${dateStr}`;
  
  openModal(elements.modalView);
  if (window.lucide) window.lucide.createIcons();
}

function renderModalProductsTable(doc) {
  const tbody = document.getElementById('modal-products-body');
  tbody.innerHTML = '';
  
  if (!doc.products || doc.products.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem 1rem;">
          Няма добавени продукти. Натиснете "Добави продукт", за да добавите.
        </td>
      </tr>
    `;
    return;
  }
  
  doc.products.forEach((p, index) => {
    const tr = document.createElement('tr');
    
    // Ensure properties exist
    const pName = p.name || '';
    const pQty = p.quantity != null ? p.quantity : 1;
    const pPrice = p.price != null ? p.price : '';
    
    tr.innerHTML = `
      <td>
        <input type="text" class="products-table-input name-input" value="${escapeHTML(pName)}" data-index="${index}" placeholder="Продукт / Услуга">
      </td>
      <td>
        <input type="number" class="products-table-input qty-input" value="${pQty}" min="1" data-index="${index}">
      </td>
      <td style="position: relative; display: flex; align-items: center;">
        <input type="number" step="0.01" class="products-table-input price-input" value="${pPrice}" placeholder="0.00" style="padding-right: 20px;" data-index="${index}">
        <span style="position: absolute; right: 8px; font-size: 0.8rem; color: var(--text-secondary); pointer-events: none;">€</span>
      </td>
      <td style="text-align: center;">
        <button type="button" class="btn-table-delete" data-index="${index}" title="Изтрий ред">
          <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
        </button>
      </td>
    `;
    
    // Bind change listeners directly
    const nameInput = tr.querySelector('.name-input');
    const qtyInput = tr.querySelector('.qty-input');
    const priceInput = tr.querySelector('.price-input');
    
    nameInput.addEventListener('input', (e) => {
      p.name = e.target.value;
      localStorage.setItem('saved_documents', JSON.stringify(state.documents));
      renderDocumentList();
    });
    
    qtyInput.addEventListener('input', (e) => {
      p.quantity = e.target.value !== '' ? parseInt(e.target.value, 10) : 1;
      localStorage.setItem('saved_documents', JSON.stringify(state.documents));
      renderDocumentList();
    });
    
    priceInput.addEventListener('input', (e) => {
      const val = e.target.value;
      p.price = val !== '' ? parseFloat(val) : null;
      localStorage.setItem('saved_documents', JSON.stringify(state.documents));
      renderDocumentList();
    });
    
    tbody.appendChild(tr);
  });
  
  if (window.lucide) window.lucide.createIcons();
}

// API Key Updates
function updateApiKeyBadge() {
  const isKeyConfigured = state.apiKey && state.apiKey.length > 10;
  
  if (isKeyConfigured) {
    elements.apiKeyBadge.className = 'badge badge-success';
    elements.apiKeyBadge.innerHTML = `<i data-lucide="check-circle-2"></i>`;
  } else {
    elements.apiKeyBadge.className = 'badge badge-error';
    elements.apiKeyBadge.innerHTML = `<i data-lucide="circle-x"></i>`;
  }
  
  if (window.lucide) window.lucide.createIcons();
}

function updateCloudConvertApiKeyBadge() {
  const isKeyConfigured = state.cloudConvertApiKey && state.cloudConvertApiKey.length > 10;
  
  if (elements.cloudConvertApiKeyBadge) {
    if (isKeyConfigured) {
      elements.cloudConvertApiKeyBadge.className = 'badge badge-success';
      elements.cloudConvertApiKeyBadge.innerHTML = `<i data-lucide="check-circle-2"></i>`;
    } else {
      elements.cloudConvertApiKeyBadge.className = 'badge badge-error';
      elements.cloudConvertApiKeyBadge.innerHTML = `<i data-lucide="circle-x"></i>`;
    }
  }
  
  if (window.lucide) window.lucide.createIcons();
}

function showSettingsPanelAndFocusKey() {
  if (!unlockSettings()) return;
  if (elements.backupPanel) {
    elements.backupPanel.classList.remove('hidden');
  }
  if (elements.apiKeyInput) {
    elements.apiKeyInput.focus();
    elements.apiKeyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  showToast('Моля, конфигурирайте първо вашия Gemini API ключ.', 'key');
}

function showSettingsPanelAndFocusCloudConvertKey() {
  if (!unlockSettings()) return;
  if (elements.backupPanel) {
    elements.backupPanel.classList.remove('hidden');
  }
  if (elements.cloudConvertApiKeyInput) {
    elements.cloudConvertApiKeyInput.focus();
    elements.cloudConvertApiKeyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

let lightboxScale = 1;
let panX = 0;
let panY = 0;
let isDraggingLightbox = false;
let startX = 0;
let startY = 0;
let activeLightboxBlobUrl = null;

function updateLightboxTransform() {
  elements.lightboxImg.style.transform = `translate(${panX}px, ${panY}px) scale(${lightboxScale})`;
  if (lightboxScale > 1) {
    elements.lightboxImg.style.cursor = isDraggingLightbox ? 'grabbing' : 'grab';
  } else {
    elements.lightboxImg.style.cursor = 'zoom-in';
  }
}

function openImageLightbox(imageSrc, name) {
  // Clear any file states
  document.getElementById('lightbox-iframe').classList.add('hidden');
  document.getElementById('lightbox-text').classList.add('hidden');
  document.getElementById('lightbox-fallback').classList.add('hidden');
  elements.lightboxImg.classList.remove('hidden');
  
  elements.lightboxImg.src = imageSrc;
  elements.lightboxCaption.textContent = name;
  
  // Reset zoom & pan offset
  lightboxScale = 1;
  panX = 0;
  panY = 0;
  updateLightboxTransform();
  
  openModal(elements.modalImage);
}

function openFileInModal(base64DataUrl, fileName) {
  const img = document.getElementById('lightbox-img');
  const iframe = document.getElementById('lightbox-iframe');
  const textContainer = document.getElementById('lightbox-text');
  const fallback = document.getElementById('lightbox-fallback');
  const caption = document.getElementById('lightbox-caption');
  const downloadBtn = document.getElementById('btn-lightbox-download');
  
  // Hide all first
  img.classList.add('hidden');
  iframe.classList.add('hidden');
  textContainer.classList.add('hidden');
  fallback.classList.add('hidden');
  
  // Reset zoom & pan offset
  lightboxScale = 1;
  panX = 0;
  panY = 0;
  updateLightboxTransform();
  
  // Revoke previous Blob URL if any
  if (activeLightboxBlobUrl) {
    URL.revokeObjectURL(activeLightboxBlobUrl);
    activeLightboxBlobUrl = null;
  }
  
  caption.textContent = fileName;
  
  const isImage = checkIsImage(base64DataUrl);
  const isPdf = checkIsPdf(base64DataUrl);
  const isText = checkIsText(base64DataUrl);
  const isDataUrl = base64DataUrl && base64DataUrl.startsWith('data:');

  if (isImage) {
    img.src = base64DataUrl;
    img.classList.remove('hidden');
  } else if (isPdf) {
    if (isDataUrl) {
      try {
        const parts = base64DataUrl.split(';base64,');
        const contentType = parts[0].split(':')[1];
        const raw = window.atob(parts[1]);
        const rawLength = raw.length;
        const uInt8Array = new Uint8Array(rawLength);
        for (let i = 0; i < rawLength; ++i) {
          uInt8Array[i] = raw.charCodeAt(i);
        }
        const blob = new Blob([uInt8Array], { type: contentType });
        activeLightboxBlobUrl = URL.createObjectURL(blob);

        iframe.src = activeLightboxBlobUrl;
      } catch (e) {
        console.error("Failed to render PDF in iframe", e);
        iframe.src = base64DataUrl;
      }
    } else {
      // Saved uploads/ URL — let the dev server serve it directly.
      iframe.src = base64DataUrl;
    }
    iframe.classList.remove('hidden');
  } else if (isText) {
    if (isDataUrl) {
      try {
        const parts = base64DataUrl.split(';base64,');
        const decodedText = decodeURIComponent(escape(window.atob(parts[1])));
        textContainer.textContent = decodedText;
      } catch (e) {
        try {
          const parts = base64DataUrl.split(';base64,');
          textContainer.textContent = window.atob(parts[1]);
        } catch (err) {
          textContainer.textContent = "Неуспешно зареждане на текстовия файл.";
        }
      }
      textContainer.classList.remove('hidden');
    } else {
      // Saved uploads/ URL — fetch the text content from the server.
      fetch(base64DataUrl)
        .then(r => r.text())
        .then(t => { textContainer.textContent = t; })
        .catch(() => { textContainer.textContent = "Неуспешно зареждане на текстовия файл."; });
      textContainer.classList.remove('hidden');
    }
  } else {
    // Show download button fallback
    downloadBtn.href = base64DataUrl;
    downloadBtn.download = fileName;
    fallback.classList.remove('hidden');
  }
  
  openModal(elements.modalImage);
  if (window.lucide) window.lucide.createIcons();
}



// Expand/Collapse Capture Panels Helpers
function expandCapturePanel(page) {
  if (page === 'invoices') {
    elements.btnExpandCapture.classList.add('hidden');
    elements.capturePanelInvoices.classList.remove('hidden');
    if (state.activeSource === 'camera') startCamera();
  } else if (page === 'documents') {
    elements.btnExpandCaptureDocs.classList.add('hidden');
    elements.capturePanelDocs.classList.remove('hidden');
    if (state.activeSourceDocs === 'camera') startCamera();
  } else if (page === 'staff') {
    elements.btnExpandCaptureStaff.classList.add('hidden');
    elements.capturePanelStaff.classList.remove('hidden');
    if (state.activeSourceStaff === 'camera') startCamera();
  }
  if (window.lucide) window.lucide.createIcons();
}

function collapseCapturePanel(page) {
  if (window.innerWidth < 768) return;
  if (page === 'invoices') {
    elements.btnExpandCapture.classList.remove('hidden');
    elements.capturePanelInvoices.classList.add('hidden');
    stopCamera();
  } else if (page === 'documents') {
    elements.btnExpandCaptureDocs.classList.remove('hidden');
    elements.capturePanelDocs.classList.add('hidden');
    stopCamera();
  } else if (page === 'staff') {
    elements.btnExpandCaptureStaff.classList.remove('hidden');
    elements.capturePanelStaff.classList.add('hidden');
    stopCamera();
  }
  if (window.lucide) window.lucide.createIcons();
}

// ==========================================
// Event Listeners Setup
// ==========================================

function setupEventListeners() {
  const syncSearchFields = (value) => {
    if (elements.searchInput && elements.searchInput.value !== value) {
      elements.searchInput.value = value;
    }
    if (elements.searchInputDocs && elements.searchInputDocs.value !== value) {
      elements.searchInputDocs.value = value;
    }
    if (elements.searchInputStaff && elements.searchInputStaff.value !== value) {
      elements.searchInputStaff.value = value;
    }

    const toggleClearButton = (btn, show) => {
      if (btn) {
        if (show) {
          btn.classList.remove('hidden');
        } else {
          btn.classList.add('hidden');
        }
      }
    };
    toggleClearButton(elements.btnClearSearch, !!value);
    toggleClearButton(elements.btnClearSearchDocs, !!value);
    toggleClearButton(elements.btnClearSearchStaff, !!value);

    state.currentPage = 1;
    state.currentPageDocs = 1;
    state.currentPageStaffGen = 1;
    renderDocumentList();
    renderGeneralDocumentList();
    renderStaffList();
    renderStaffGeneralDocsList();
  };

  // Add Staff Button
  if (elements.btnAddStaff) {
    elements.btnAddStaff.addEventListener('click', () => {
      elements.btnAddStaffName.value = '';
      elements.btnAddStaffPosition.value = '';
      elements.btnAddStaffDate.value = new Date().toISOString().slice(0, 10);
      openModal(elements.modalAddStaff);
    });
  }
  
  // Submit Add Staff
  if (elements.btnSubmitAddStaff) {
    elements.btnSubmitAddStaff.addEventListener('click', () => {
      const name = elements.btnAddStaffName.value.trim();
      const position = elements.btnAddStaffPosition.value.trim();
      const date = elements.btnAddStaffDate.value;
      
      if (!name) {
        showToast('Името е задължително!', 'alert-triangle');
        return;
      }
      
      const newPerson = {
        id: 'emp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        position: position || '',
        hiringDate: date || new Date().toISOString().slice(0, 10),
        isArchived: false,
        archiveDate: null,
        documents: []
      };
      
      state.staff.unshift(newPerson);
      localStorage.setItem('saved_staff', JSON.stringify(state.staff));
      
      renderStaffList();
      closeModal(elements.modalAddStaff);
      showToast('Служителят е добавен.', 'user-plus');
    });
  }

  // Add Expense No File Button
  if (elements.btnAddExpenseNoFile) {
    elements.btnAddExpenseNoFile.addEventListener('click', () => {
      elements.btnAddExpenseName.value = '';
      elements.btnAddExpenseDate.value = new Date().toISOString().slice(0, 10);
      elements.btnAddExpenseAmount.value = '';
      openModal(elements.modalAddExpenseNoFile);
    });
  }
  
  // Submit Add Expense No File
  if (elements.btnSubmitAddExpense) {
    elements.btnSubmitAddExpense.addEventListener('click', () => {
      const name = elements.btnAddExpenseName.value.trim();
      const date = elements.btnAddExpenseDate.value;
      const amount = elements.btnAddExpenseAmount.value.trim();
      
      if (!name) {
        showToast('Името е задължително!', 'alert-triangle');
        return;
      }
      
      const newDoc = {
        id: 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        supplier: name,
        recipient: '',
        date: date || new Date().toISOString().slice(0, 10),
        totalAmount: amount ? Number(amount) : 0,
        type: 'other',
        image: null,
        timestamp: new Date().toISOString(),
        transcription: 'Ръчно въведен разход без прикачен файл.',
        products: []
      };
      
      state.documents.unshift(newDoc);
      localStorage.setItem('saved_documents', JSON.stringify(state.documents));
      
      state.activeTab = 'other';
      state.currentPage = 1;
      elements.tabLinks.forEach(t => {
        if (t.getAttribute('data-tab') === 'other') {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
      
      renderDocumentList();
      closeModal(elements.modalAddExpenseNoFile);
      showToast('Разходът е добавен.', 'check');
    });
  }

  // Real-time API Key Sync
  if (elements.apiKeyInput) {
    elements.apiKeyInput.addEventListener('input', (e) => {
      const key = e.target.value.trim();
      state.apiKey = key;
      localStorage.setItem('gemini_api_key', key);
      updateApiKeyBadge();
    });
  }

  // Real-time CloudConvert API Key Sync
  if (elements.cloudConvertApiKeyInput) {
    elements.cloudConvertApiKeyInput.addEventListener('input', (e) => {
      const key = e.target.value.trim();
      state.cloudConvertApiKey = key;
      localStorage.setItem('cloudconvert_api_key', key);
      updateCloudConvertApiKeyBadge();
    });
  }

  // Real-time conversion output-format sync (PDF vs PNG image)
  if (elements.cloudConvertFormatSelect) {
    elements.cloudConvertFormatSelect.addEventListener('change', (e) => {
      const fmt = e.target.value === 'png' ? 'png' : 'pdf';
      state.cloudConvertFormat = fmt;
      localStorage.setItem('cloudconvert_format', fmt);
    });
  }

  // Real-time Access PIN Sync & Validation
  if (elements.appPinInput) {
    elements.appPinInput.addEventListener('change', async (e) => {
      const pin = e.target.value.trim();
      const oldPin = localStorage.getItem('app_access_pin') || '1234';
      if (!/^\d{4,10}$/.test(pin)) {
        showToast('PIN кодът трябва да бъде между 4 и 10 цифри!', 'alert-triangle');
        elements.appPinInput.value = oldPin;
        return;
      }
      if (pin === oldPin) return; // no change

      // Update the shared PIN on the server first (authenticated with the current
      // PIN) so the server and every device stay in agreement.
      try {
        const r = await fetch(syncEndpoint('/api/set-pin'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Token': oldPin },
          body: JSON.stringify({ value: pin })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      } catch (err) {
        console.warn('Set PIN failed:', err);
        showToast('PIN не е променен (няма връзка със сървъра): ' + (err && err.message ? err.message : 'грешка'), 'alert-circle');
        elements.appPinInput.value = oldPin;
        return;
      }

      localStorage.setItem('app_access_pin', pin);
      showToast('PIN кодът е променен.', 'check-circle');
    });
  }

  // Admin password sync (gates deletions + Settings access). Saved per-device,
  // not included in backups. Empty reverts to the default "1234".
  if (elements.adminPasswordInput) {
    elements.adminPasswordInput.addEventListener('change', (e) => {
      const pwd = e.target.value.trim();
      localStorage.setItem('admin_delete_password', pwd);
      if (!pwd) {
        elements.adminPasswordInput.value = DEFAULT_ADMIN_PASSWORD;
        showToast(`Паролата е върната по подразбиране (${DEFAULT_ADMIN_PASSWORD}).`, 'info');
      } else {
        showToast('Администраторската парола е променена.', 'check-circle');
      }
    });
  }

  // Manual "refresh from server" button (pull another device's changes).
  if (elements.btnSyncRefresh) {
    elements.btnSyncRefresh.addEventListener('click', () => {
      showToast('Зареждане от сървъра...', 'refresh-cw');
      loadStateFromServer().then(() => showToast('Готово.', 'check-circle'));
    });
  }

  // Header Company Input - real-time sync
  if (elements.headerCompanyInput) {
    elements.headerCompanyInput.addEventListener('input', (e) => {
      state.myCompany = e.target.value.trim();
      localStorage.setItem('my_company_name', state.myCompany);
      renderDocumentList();
    });
  }

  // Theme Toggle Button
  elements.btnThemeToggle.addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', state.theme);
    applyTheme();
    showToast(`Превключено на ${state.theme === 'light' ? 'светла' : 'тъмна'} тема.`, 'sun');
  });

  // Category dropdown in details modal
  const viewCategorySelect = document.getElementById('view-category');
  viewCategorySelect.addEventListener('change', (e) => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        doc.type = e.target.value;
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        
        // Dynamic UI adjustment for taxes
        const isTaxes = (doc.type === 'taxes');
        const supplierInput = document.getElementById('view-supplier');
        const supplierLabel = supplierInput.closest('.input-group-modal').querySelector('label');
        if (supplierLabel) {
          supplierLabel.textContent = isTaxes ? 'Основание / Grounds' : 'Доставчик / Supplier';
        }
        const recipientInput = document.getElementById('view-recipient');
        const recipientGroup = recipientInput.closest('.input-group-modal');
        if (recipientGroup) {
          if (isTaxes) {
            recipientGroup.classList.add('hidden');
          } else {
            recipientGroup.classList.remove('hidden');
          }
        }
        const productsGroup = document.getElementById('btn-add-product').closest('.input-group-modal');
        if (productsGroup) {
          if (isTaxes) {
            productsGroup.classList.add('hidden');
          } else {
            productsGroup.classList.remove('hidden');
          }
        }
        
        renderDocumentList();
        showToast('Категорията е променена.', 'folder');
      }
    }
  });
  
  // Close Modals buttons
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      const targetModalId = button.getAttribute('data-close');
      closeModal(document.getElementById(targetModalId));
    });
  });
  
  // Close modals when clicking backdrop
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeModal(backdrop);
      }
    });
  });

  // Settings Gear Trigger (Footer Collapse/Expand) — gated by the admin password.
  document.querySelectorAll('.btn-settings-gear').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!elements.backupPanel) return;
      const opening = elements.backupPanel.classList.contains('hidden');
      if (opening) {
        if (!unlockSettings()) return; // require admin password to open
        elements.backupPanel.classList.remove('hidden');
      } else {
        elements.backupPanel.classList.add('hidden'); // closing needs no password
      }
    });
  });

  // Mobile Camera Capture Actions
  const btnMobileCamera = document.getElementById('btn-mobile-camera');
  const mobileCameraInput = document.getElementById('mobile-camera-input');
  
  if (btnMobileCamera && mobileCameraInput) {
    btnMobileCamera.addEventListener('click', () => {
      mobileCameraInput.click();
    });
    
    mobileCameraInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFile(file);
      }
    });
  }

  const btnMobileCameraDocs = document.getElementById('btn-mobile-camera-docs');
  const mobileCameraInputDocs = document.getElementById('mobile-camera-input-docs');
  
  if (btnMobileCameraDocs && mobileCameraInputDocs) {
    btnMobileCameraDocs.addEventListener('click', () => {
      mobileCameraInputDocs.click();
    });
    
    mobileCameraInputDocs.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFileDocs(file);
      }
    });
  }

  const btnMobileCameraStaff = document.getElementById('btn-mobile-camera-staff');
  const mobileCameraInputStaff = document.getElementById('mobile-camera-input-staff');
  
  if (btnMobileCameraStaff && mobileCameraInputStaff) {
    btnMobileCameraStaff.addEventListener('click', () => {
      mobileCameraInputStaff.click();
    });
    
    mobileCameraInputStaff.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFileStaff(file);
      }
    });
  }

  // Mobile "Качи" buttons — upload from the camera roll, multi-select supported.
  const wireMobileUpload = (btnId, inputId, single, viewType) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      if (files.length === 1) single(files[0]);
      else processMultipleFiles(files, viewType);
      e.target.value = '';
    });
  };
  wireMobileUpload('btn-mobile-upload', 'mobile-upload-input', handleFile, 'invoices');
  wireMobileUpload('btn-mobile-upload-docs', 'mobile-upload-input-docs', handleFileDocs, 'docs');
  wireMobileUpload('btn-mobile-upload-staff', 'mobile-upload-input-staff', handleFileStaff, 'staff');

  // Camera Capture & Image Preview Actions
  if (elements.btnCapture) elements.btnCapture.addEventListener('click', capturePhoto);
  if (elements.btnRetryCamera) elements.btnRetryCamera.addEventListener('click', startCamera);
  elements.btnRotatePreview.addEventListener('click', rotateImage90Degrees);
  elements.btnResetPreview.addEventListener('click', resetPreview);

  // File Upload Drag & Drop
  const dropzone = elements.dropzone;
  
  dropzone.addEventListener('click', () => elements.fileInput.click());
  
  elements.fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    if (files.length === 1) {
      handleFile(files[0]);
    } else {
      processMultipleFiles(files, 'invoices');
    }
    e.target.value = '';
  });
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--accent)';
    dropzone.style.background = 'rgba(0, 210, 255, 0.05)';
  });
  
  ['dragleave', 'dragend'].forEach(type => {
    dropzone.addEventListener(type, () => {
      dropzone.style.borderColor = 'var(--border-color)';
      dropzone.style.background = '';
    });
  });
  
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-color)';
    dropzone.style.background = '';
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length === 1) {
      handleFile(files[0]);
    } else {
      processMultipleFiles(files, 'invoices');
    }
  });

  // Transcribe action
  elements.btnTranscribe.addEventListener('click', transcribeDocument);
  
  // Tabs Navigation
  elements.tabLinks.forEach(tab => {
    tab.addEventListener('click', () => {
      elements.tabLinks.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeTab = tab.getAttribute('data-tab');
      state.currentPage = 1;
      renderDocumentList();
    });
  });
  
  // Search box filtering
  elements.searchInput.addEventListener('input', (e) => {
    syncSearchFields(e.target.value);
  });
  if (elements.btnClearSearch) {
    elements.btnClearSearch.addEventListener('click', () => {
      syncSearchFields('');
    });
  }
  
  // Date Range Filtering Events
  if (elements.filterStartDate) {
    elements.filterStartDate.addEventListener('change', () => {
      state.currentPage = 1;
      renderDocumentList();
    });
  }
  if (elements.filterEndDate) {
    elements.filterEndDate.addEventListener('change', () => {
      state.currentPage = 1;
      renderDocumentList();
    });
  }
  if (elements.btnClearDates) {
    elements.btnClearDates.addEventListener('click', () => {
      if (elements.filterStartDate) elements.filterStartDate.value = '';
      if (elements.filterEndDate) elements.filterEndDate.value = '';
      state.currentPage = 1;
      renderDocumentList();
    });
  }

  // Pagination Events
  if (elements.btnPrevPage) {
    elements.btnPrevPage.addEventListener('click', () => {
      if (state.currentPage > 1) {
        state.currentPage--;
        renderDocumentList();
      }
    });
  }
  if (elements.btnNextPage) {
    elements.btnNextPage.addEventListener('click', () => {
      state.currentPage++;
      renderDocumentList();
    });
  }
  
  // Clear all button
  if (elements.btnClearAll) {
    elements.btnClearAll.addEventListener('click', clearAllDocuments);
  }
  
  // Detailed Modal Inline Edit Listeners
  const modalSupplier = document.getElementById('view-supplier');
  const modalRecipient = document.getElementById('view-recipient');
  const modalDate = document.getElementById('view-date-input');
  const modalAmount = document.getElementById('view-amount');

  modalSupplier.addEventListener('input', (e) => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        doc.supplier = e.target.value;
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderDocumentList();
      }
    }
  });

  modalRecipient.addEventListener('input', (e) => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        doc.recipient = e.target.value;
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderDocumentList();
      }
    }
  });

  modalDate.addEventListener('input', (e) => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        doc.date = e.target.value;
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderDocumentList();
      }
    }
  });

  modalDate.addEventListener('click', (e) => {
    if (typeof e.target.showPicker === 'function') {
      try {
        e.target.showPicker();
      } catch (err) {}
    }
  });

  modalAmount.addEventListener('input', (e) => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        const val = e.target.value;
        doc.totalAmount = val !== '' ? parseFloat(val) : null;
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderDocumentList();
      }
    }
  });

  // Add Product button inside modal
  const btnAddProduct = document.getElementById('btn-add-product');
  btnAddProduct.addEventListener('click', () => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        if (!doc.products) doc.products = [];
        doc.products.push({ name: '', quantity: 1, price: null });
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderModalProductsTable(doc);
        renderDocumentList();
        
        // Focus name input of newly added row
        setTimeout(() => {
          const rows = document.querySelectorAll('#modal-products-body tr');
          if (rows.length > 0) {
            const lastRowNameInput = rows[rows.length - 1].querySelector('.name-input');
            if (lastRowNameInput) lastRowNameInput.focus();
          }
        }, 50);
      }
    }
  });

  // Table row deletion delegation
  const modalProductsBody = document.getElementById('modal-products-body');
  modalProductsBody.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.btn-table-delete');
    if (deleteBtn && state.currentlyViewingDocId) {
      const index = parseInt(deleteBtn.dataset.index, 10);
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        doc.products.splice(index, 1);
        localStorage.setItem('saved_documents', JSON.stringify(state.documents));
        renderModalProductsTable(doc);
        renderDocumentList();
      }
    }
  });

  // Delete document from detail pane
  elements.btnDeleteDoc.addEventListener('click', () => {
    if (state.currentlyViewingDocId) {
      if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
        deleteDocument(state.currentlyViewingDocId);
      }
    }
  });
  
  // Expand image in details pane to lightbox / open file in new tab
  // Expand image in details pane to lightbox / open file in modal
  elements.btnViewExpand.addEventListener('click', () => {
    if (state.currentlyViewingDocId) {
      const doc = state.documents.find(d => d.id === state.currentlyViewingDocId);
      if (doc) {
        openFileInModal(doc.image, doc.name);
      }
    }
  });

  // Lightbox Zoom and Pan Event Listeners
  elements.lightboxImg.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    // Normalize zoom factor based on scroll velocity (less sensitive)
    const zoomIntensity = 0.001;
    lightboxScale += -e.deltaY * zoomIntensity;
    
    // Clamp scale between 1 and 6
    lightboxScale = Math.min(Math.max(1, lightboxScale), 6);
    
    // If zoom is back to 1, reset translation
    if (lightboxScale === 1) {
      panX = 0;
      panY = 0;
    }
    
    updateLightboxTransform();
  }, { passive: false });

  // Drag-to-pan events (Mouse)
  elements.lightboxImg.addEventListener('mousedown', (e) => {
    if (lightboxScale <= 1) return;
    e.preventDefault();
    isDraggingLightbox = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    updateLightboxTransform();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingLightbox) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    updateLightboxTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isDraggingLightbox) {
      isDraggingLightbox = false;
      updateLightboxTransform();
    }
  });

  // Drag-to-pan events (Touch)
  elements.lightboxImg.addEventListener('touchstart', (e) => {
    if (lightboxScale <= 1) return;
    if (e.touches.length === 1) {
      isDraggingLightbox = true;
      startX = e.touches[0].clientX - panX;
      startY = e.touches[0].clientY - panY;
    }
  });

  window.addEventListener('touchmove', (e) => {
    if (!isDraggingLightbox) return;
    if (e.touches.length === 1) {
      panX = e.touches[0].clientX - startX;
      panY = e.touches[0].clientY - startY;
      updateLightboxTransform();
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDraggingLightbox = false;
  });

  // Click to close lightbox if not zoomed in
  elements.lightboxImg.addEventListener('click', () => {
    if (lightboxScale <= 1) {
      closeModal(elements.modalImage);
    }
  });

  // Hover image preview delegation
  elements.documentList.addEventListener('mouseover', (e) => {
    if (window.innerWidth < 768) return;
    const target = e.target.closest('.btn-view-img, .doc-thumb-link');
    if (target) {
      const id = target.dataset.id;
      const doc = state.documents.find(d => d.id === id);
      if (doc && checkIsImage(doc.image)) {
        elements.hoverPreviewImg.src = doc.image;
        elements.hoverPreview.classList.remove('hidden');
      }
    }
  });

  elements.documentList.addEventListener('mousemove', (e) => {
    if (window.innerWidth < 768 || elements.hoverPreview.classList.contains('hidden')) return;
    
    let top = e.clientY + 15;
    let left = e.clientX + 15;
    
    const previewWidth = 260;
    const previewHeight = 340;
    
    if (left + previewWidth > window.innerWidth) {
      left = e.clientX - previewWidth - 15;
    }
    if (top + previewHeight > window.innerHeight) {
      top = e.clientY - previewHeight - 15;
    }
    
    elements.hoverPreview.style.top = top + 'px';
    elements.hoverPreview.style.left = left + 'px';
  });

  elements.documentList.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.btn-view-img, .doc-thumb-link');
    if (target) {
      if (!target.contains(e.relatedTarget)) {
        elements.hoverPreview.classList.add('hidden');
        elements.hoverPreviewImg.src = '';
      }
    }
  });

  // Escape key modal closing handling
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const isLightboxOpen = !elements.modalImage.classList.contains('hidden');
      const isDetailsOpen = !elements.modalView.classList.contains('hidden');
      const isDocDetailsOpen = !elements.modalDocDetails.classList.contains('hidden');
      const isStaffDocDetailsOpen = !elements.modalStaffDocDetails.classList.contains('hidden');
      
      if (isLightboxOpen) {
        closeModal(elements.modalImage);
      } else if (isDetailsOpen) {
        closeModal(elements.modalView);
      } else if (isDocDetailsOpen) {
        closeModal(elements.modalDocDetails);
      } else if (isStaffDocDetailsOpen) {
        closeModal(elements.modalStaffDocDetails);
      }
    }
  });

  // Backup & Restore Event Listeners
  elements.btnBackup.addEventListener('click', backupDataZip);
  elements.btnRestore.addEventListener('click', () => {
    elements.backupFileInput.click();
  });
  elements.backupFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      handleRestoreFile(file);
    }
    e.target.value = ''; // Reset file input
  });

  // Staff General Documents Tab Links Click Listeners
  if (elements.staffGenTabLinks) {
    elements.staffGenTabLinks.forEach(tab => {
      tab.addEventListener('click', () => {
        elements.staffGenTabLinks.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.activeTabStaffGen = tab.getAttribute('data-tab');
        state.currentPageStaffGen = 1;
        renderStaffGeneralDocsList();
      });
    });
  }

  // Staff General Documents Pagination Click Listeners
  if (elements.btnPrevPageStaffGen) {
    elements.btnPrevPageStaffGen.addEventListener('click', () => {
      if (state.currentPageStaffGen > 1) {
        state.currentPageStaffGen--;
        renderStaffGeneralDocsList();
      }
    });
  }
  if (elements.btnNextPageStaffGen) {
    elements.btnNextPageStaffGen.addEventListener('click', () => {
      state.currentPageStaffGen++;
      renderStaffGeneralDocsList();
    });
  }

  // Drag Source Events (delegated on document list)
  elements.documentList.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.invoice-item, .document-card');
    if (item) {
      e.dataTransfer.setData('text/plain', item.dataset.id);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  elements.documentList.addEventListener('dragend', (e) => {
    const item = e.target.closest('.invoice-item, .document-card');
    if (item) {
      item.classList.remove('dragging');
    }
  });

  // Drag Target Events (attached to each tab link)
  elements.tabLinks.forEach(tab => {
    tab.addEventListener('dragover', (e) => {
      e.preventDefault(); // crucial: allows dropping!
      e.dataTransfer.dropEffect = 'move';
    });

    tab.addEventListener('dragenter', (e) => {
      e.preventDefault();
      tab.classList.add('drag-over');
    });

    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over');
    });

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over');

      const docId = e.dataTransfer.getData('text/plain');
      const targetTab = tab.getAttribute('data-tab');

      if (docId && targetTab) {
        const doc = state.documents.find(d => d.id === docId);
        if (doc) {
          const tabToType = {
            'invoices': 'invoice',
            'bills': 'bills',
            'revenue-invoices': 'revenue-invoice',
            'receipts': 'receipt',
            'taxes': 'taxes',
            'other': 'other'
          };
          const targetType = tabToType[targetTab];

          if (targetType && doc.type !== targetType) {
            doc.type = targetType;
            localStorage.setItem('saved_documents', JSON.stringify(state.documents));
            renderDocumentList();
            showToast('Документът е преместен.', 'folder');
          }
        }
      }
    });
  });

  // ==========================================
  // New Multi-Page Navigation Listeners
  // ==========================================
  if (elements.navInvoices) elements.navInvoices.addEventListener('click', () => switchPage('invoices'));
  if (elements.navDocuments) elements.navDocuments.addEventListener('click', () => switchPage('documents'));
  if (elements.navStaff) elements.navStaff.addEventListener('click', () => switchPage('staff'));

  // ==========================================
  // General Documents Page Event Listeners
  // ==========================================
  if (elements.toggleCameraDocs) {
    elements.toggleCameraDocs.addEventListener('click', () => {
      elements.toggleCameraDocs.classList.add('active');
      elements.toggleUploadDocs.classList.remove('active');
      state.activeSourceDocs = 'camera';
      updateSourceVisibilityDocs();
      if (!state.capturedImageBase64Docs) startCamera();
    });
  }
  
  if (elements.toggleUploadDocs) {
    elements.toggleUploadDocs.addEventListener('click', () => {
      elements.toggleUploadDocs.classList.add('active');
      elements.toggleCameraDocs.classList.remove('active');
      state.activeSourceDocs = 'upload';
      updateSourceVisibilityDocs();
      stopCamera();
    });
  }

  if (elements.dropzoneDocs) {
    elements.dropzoneDocs.addEventListener('click', () => elements.fileInputDocs.click());
  }
  if (elements.fileInputDocs) {
    elements.fileInputDocs.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      if (files.length === 1) {
        handleFileDocs(files[0]);
      } else {
        processMultipleFiles(files, 'docs');
      }
      e.target.value = '';
    });
  }

  if (elements.dropzoneDocs) {
    elements.dropzoneDocs.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropzoneDocs.style.borderColor = 'var(--accent)';
      elements.dropzoneDocs.style.background = 'rgba(0, 210, 255, 0.05)';
    });
    
    ['dragleave', 'dragend'].forEach(type => {
      elements.dropzoneDocs.addEventListener(type, () => {
        elements.dropzoneDocs.style.borderColor = 'var(--border-color)';
        elements.dropzoneDocs.style.background = '';
      });
    });
    
    elements.dropzoneDocs.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropzoneDocs.style.borderColor = 'var(--border-color)';
      elements.dropzoneDocs.style.background = '';
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      if (files.length === 1) {
        handleFileDocs(files[0]);
      } else {
        processMultipleFiles(files, 'docs');
      }
    });
  }

  if (elements.btnTranscribeDocs) {
    elements.btnTranscribeDocs.addEventListener('click', transcribeGeneralDocument);
  }

  elements.docTabLinks.forEach(tab => {
    tab.addEventListener('click', () => {
      elements.docTabLinks.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeTabDocs = tab.getAttribute('data-tab');
      state.currentPageDocs = 1;
      renderGeneralDocumentList();
    });
  });

  if (elements.searchInputDocs) {
    elements.searchInputDocs.addEventListener('input', (e) => {
      syncSearchFields(e.target.value);
    });
  }
  if (elements.btnClearSearchDocs) {
    elements.btnClearSearchDocs.addEventListener('click', () => {
      syncSearchFields('');
    });
  }

  if (elements.filterStartDateDocs) {
    elements.filterStartDateDocs.addEventListener('change', () => {
      state.currentPageDocs = 1;
      renderGeneralDocumentList();
    });
  }

  if (elements.filterEndDateDocs) {
    elements.filterEndDateDocs.addEventListener('change', () => {
      state.currentPageDocs = 1;
      renderGeneralDocumentList();
    });
  }

  if (elements.btnClearDatesDocs) {
    elements.btnClearDatesDocs.addEventListener('click', () => {
      if (elements.filterStartDateDocs) elements.filterStartDateDocs.value = '';
      if (elements.filterEndDateDocs) elements.filterEndDateDocs.value = '';
      state.currentPageDocs = 1;
      renderGeneralDocumentList();
    });
  }

  if (elements.btnPrevPageDocs) {
    elements.btnPrevPageDocs.addEventListener('click', () => {
      if (state.currentPageDocs > 1) {
        state.currentPageDocs--;
        renderGeneralDocumentList();
      }
    });
  }

  if (elements.btnNextPageDocs) {
    elements.btnNextPageDocs.addEventListener('click', () => {
      state.currentPageDocs++;
      renderGeneralDocumentList();
    });
  }

  if (elements.btnClearAllDocs) {
    elements.btnClearAllDocs.addEventListener('click', () => {
      if (confirmDelete('Наистина ли искате да изтриете всички записани документи в този раздел?')) {
        state.generalDocs.forEach(d => deleteFileFromServer(d.image));
        state.generalDocs = [];
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
        renderGeneralDocumentList();
        showToast('Всички документи са изтрити.', 'trash-2');
      }
    });
  }

  // General Doc Details Modal Fields Inline Edit Bindings
  elements.viewDocName.addEventListener('input', (e) => {
    if (state.currentlyViewingDocIdDocs) {
      const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
      if (doc) {
        if (doc.type === 'trade') {
          doc.supplier = e.target.value;
          doc.name = e.target.value; // Sync with doc.name for search
        } else {
          doc.name = e.target.value;
        }
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
        renderGeneralDocumentList();
      }
    }
  });

  elements.viewDocIssueDate.addEventListener('input', (e) => {
    if (state.currentlyViewingDocIdDocs) {
      const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
      if (doc) {
        doc.issueDate = e.target.value;
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
        renderGeneralDocumentList();
      }
    }
  });

  elements.viewDocIssueDate.addEventListener('click', (e) => {
    if (typeof e.target.showPicker === 'function') {
      try {
        e.target.showPicker();
      } catch (err) {}
    }
  });

  if (elements.viewDocExpiryDate) {
    elements.viewDocExpiryDate.addEventListener('input', (e) => {
      if (state.currentlyViewingDocIdDocs) {
        const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
        if (doc) {
          doc.expiryDate = e.target.value;
          localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
          renderGeneralDocumentList();
        }
      }
    });

    elements.viewDocExpiryDate.addEventListener('click', (e) => {
      if (typeof e.target.showPicker === 'function') {
        try {
          e.target.showPicker();
        } catch (err) {}
      }
    });
  }

  elements.viewDocCategory.addEventListener('change', (e) => {
    if (state.currentlyViewingDocIdDocs) {
      const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
      if (doc) {
        doc.type = e.target.value;
        
        // Dynamically update the modal labels and inputs
        const labelElem = document.getElementById('label-view-doc-name');
        if (doc.type === 'trade') {
          if (labelElem) labelElem.textContent = 'Доставчик / Supplier';
          elements.viewDocName.placeholder = 'Доставчик...';
          if (!doc.supplier) doc.supplier = doc.name || '';
          elements.viewDocName.value = doc.supplier;
          
          // Toggle layout containers
          if (elements.containerViewDocText) elements.containerViewDocText.classList.add('hidden');
          if (elements.containerViewDocProducts) elements.containerViewDocProducts.classList.remove('hidden');
          doc.products = doc.products || [];
          renderGeneralDocProducts(doc);
        } else if (doc.type === 'statement') {
          if (labelElem) labelElem.textContent = 'Банка/Институция / Bank/Institution';
          elements.viewDocName.placeholder = 'Банка/Институция...';
          if (!doc.supplier) doc.supplier = doc.name || '';
          elements.viewDocName.value = doc.supplier;
          
          // Toggle layout containers
          if (elements.containerViewDocText) elements.containerViewDocText.classList.remove('hidden');
          if (elements.containerViewDocProducts) elements.containerViewDocProducts.classList.add('hidden');
        } else {
          if (labelElem) labelElem.textContent = 'Име на документа / Document Name';
          elements.viewDocName.placeholder = 'Договор, Разрешително...';
          elements.viewDocName.value = doc.name || '';
          
          // Toggle layout containers
          if (elements.containerViewDocText) elements.containerViewDocText.classList.remove('hidden');
          if (elements.containerViewDocProducts) elements.containerViewDocProducts.classList.add('hidden');
        }
        
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
        renderGeneralDocumentList();
        showToast('Категорията е променена.', 'folder');
      }
    }
  });

  elements.viewDocText.addEventListener('input', (e) => {
    if (state.currentlyViewingDocIdDocs) {
      const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
      if (doc) {
        doc.text = e.target.value;
        localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
      }
    }
  });

  if (elements.btnDeleteDocGeneral) {
    elements.btnDeleteDocGeneral.addEventListener('click', () => {
      if (state.currentlyViewingDocIdDocs) {
        if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
          deleteGeneralDocument(state.currentlyViewingDocIdDocs);
        }
      }
    });
  }

  if (elements.btnAddDocProduct) {
    elements.btnAddDocProduct.addEventListener('click', () => {
      if (state.currentlyViewingDocIdDocs) {
        const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
        if (doc) {
          doc.products = doc.products || [];
          doc.products.push({ product: 'Нов продукт', batch: '', expiry: '' });
          localStorage.setItem('saved_general_documents', JSON.stringify(state.generalDocs));
          renderGeneralDocProducts(doc);
        }
      }
    });
  }

  if (elements.modalDocBtnViewFull) {
    elements.modalDocBtnViewFull.addEventListener('click', () => {
      if (state.currentlyViewingDocIdDocs) {
        const doc = state.generalDocs.find(d => d.id === state.currentlyViewingDocIdDocs);
        if (doc) {
          openFileInModal(doc.image, doc.name);
        }
      }
    });
  }

  // Hover image preview delegation for General Docs
  if (elements.documentListDocs) {
    elements.documentListDocs.addEventListener('mouseover', (e) => {
      if (window.innerWidth < 768) return;
      const target = e.target.closest('.btn-view-doc-file, .doc-thumb-link');
      if (target) {
        const id = target.dataset.id;
        const doc = state.generalDocs.find(d => d.id === id);
        if (doc && checkIsImage(doc.image)) {
          elements.hoverPreviewImg.src = doc.image;
          elements.hoverPreview.classList.remove('hidden');
        }
      }
    });

    elements.documentListDocs.addEventListener('mousemove', (e) => {
      if (window.innerWidth < 768 || elements.hoverPreview.classList.contains('hidden')) return;
      
      let top = e.clientY + 15;
      let left = e.clientX + 15;
      const previewWidth = 260;
      const previewHeight = 340;
      
      if (left + previewWidth > window.innerWidth) {
        left = e.clientX - previewWidth - 15;
      }
      if (top + previewHeight > window.innerHeight) {
        top = e.clientY - previewHeight - 15;
      }
      
      elements.hoverPreview.style.top = top + 'px';
      elements.hoverPreview.style.left = left + 'px';
    });

    elements.documentListDocs.addEventListener('mouseout', (e) => {
      const target = e.target.closest('.btn-view-doc-file, .doc-thumb-link');
      if (target) {
        if (!target.contains(e.relatedTarget)) {
          elements.hoverPreview.classList.add('hidden');
          elements.hoverPreviewImg.src = '';
        }
      }
    });
  }

  // ==========================================
  // Personnel (Staff) Page Event Listeners
  // ==========================================
  if (elements.toggleCameraStaff) {
    elements.toggleCameraStaff.addEventListener('click', () => {
      elements.toggleCameraStaff.classList.add('active');
      elements.toggleUploadStaff.classList.remove('active');
      state.activeSourceStaff = 'camera';
      updateSourceVisibilityStaff();
      if (!state.capturedImageBase64Staff) startCamera();
    });
  }
  
  if (elements.toggleUploadStaff) {
    elements.toggleUploadStaff.addEventListener('click', () => {
      elements.toggleUploadStaff.classList.add('active');
      elements.toggleCameraStaff.classList.remove('active');
      state.activeSourceStaff = 'upload';
      updateSourceVisibilityStaff();
      stopCamera();
    });
  }

  if (elements.dropzoneStaff) {
    elements.dropzoneStaff.addEventListener('click', () => elements.fileInputStaff.click());
  }
  if (elements.fileInputStaff) {
    elements.fileInputStaff.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      if (files.length === 1) {
        handleFileStaff(files[0]);
      } else {
        processMultipleFiles(files, 'staff');
      }
      e.target.value = '';
    });
  }

  if (elements.dropzoneStaff) {
    elements.dropzoneStaff.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropzoneStaff.style.borderColor = 'var(--accent)';
      elements.dropzoneStaff.style.background = 'rgba(0, 210, 255, 0.05)';
    });
    
    ['dragleave', 'dragend'].forEach(type => {
      elements.dropzoneStaff.addEventListener(type, () => {
        elements.dropzoneStaff.style.borderColor = 'var(--border-color)';
        elements.dropzoneStaff.style.background = '';
      });
    });
    
    elements.dropzoneStaff.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropzoneStaff.style.borderColor = 'var(--border-color)';
      elements.dropzoneStaff.style.background = '';
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      if (files.length === 1) {
        handleFileStaff(files[0]);
      } else {
        processMultipleFiles(files, 'staff');
      }
    });
  }

  if (elements.btnTranscribeStaff) {
    elements.btnTranscribeStaff.addEventListener('click', transcribeStaffDocument);
  }

  if (elements.searchInputStaff) {
    elements.searchInputStaff.addEventListener('input', (e) => {
      syncSearchFields(e.target.value);
    });
  }
  if (elements.btnClearSearchStaff) {
    elements.btnClearSearchStaff.addEventListener('click', () => {
      syncSearchFields('');
    });
  }

  // Staff Modal Fields Inline Edit Bindings
  elements.viewStaffDocName.addEventListener('input', (e) => {
    if (state.currentlyViewingStaffPersonId && state.currentlyViewingStaffDocId) {
      const person = state.staff.find(p => p.id === state.currentlyViewingStaffPersonId);
      if (person) {
        const doc = person.documents.find(d => d.id === state.currentlyViewingStaffDocId);
        if (doc) {
          doc.name = e.target.value;
          localStorage.setItem('saved_staff', JSON.stringify(state.staff));
          renderStaffList();
        }
      }
    }
  });

  elements.viewStaffDocText.addEventListener('input', (e) => {
    if (state.currentlyViewingStaffPersonId && state.currentlyViewingStaffDocId) {
      const person = state.staff.find(p => p.id === state.currentlyViewingStaffPersonId);
      if (person) {
        const doc = person.documents.find(d => d.id === state.currentlyViewingStaffDocId);
        if (doc) {
          doc.fullText = e.target.value;
          localStorage.setItem('saved_staff', JSON.stringify(state.staff));
        }
      }
    }
  });

  if (elements.btnDeleteStaffDocSub) {
    elements.btnDeleteStaffDocSub.addEventListener('click', () => {
      if (state.currentlyViewingStaffPersonId && state.currentlyViewingStaffDocId) {
        if (confirmDelete('Наистина ли искате да изтриете този документ?')) {
          deleteStaffDocument(state.currentlyViewingStaffPersonId, state.currentlyViewingStaffDocId);
          closeModal(elements.modalStaffDocDetails);
        }
      }
    });
  }

  // General Doc/Staff Mobile Camera Inputs
  if (elements.btnMobileCameraDocs && elements.mobileCameraInputDocs) {
    elements.btnMobileCameraDocs.addEventListener('click', () => elements.mobileCameraInputDocs.click());
    elements.mobileCameraInputDocs.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileDocs(file);
    });
  }
  
  if (elements.btnMobileCameraStaff && elements.mobileCameraInputStaff) {
    elements.btnMobileCameraStaff.addEventListener('click', () => elements.mobileCameraInputStaff.click());
    elements.mobileCameraInputStaff.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileStaff(file);
    });
  }

  // Expand/Collapse Capture Panels Events
  if (elements.btnExpandCapture) {
    elements.btnExpandCapture.addEventListener('click', () => expandCapturePanel('invoices'));
  }
  if (elements.btnCloseCaptureInvoices) {
    elements.btnCloseCaptureInvoices.addEventListener('click', () => collapseCapturePanel('invoices'));
  }

  if (elements.btnExpandCaptureDocs) {
    elements.btnExpandCaptureDocs.addEventListener('click', () => expandCapturePanel('documents'));
  }
  if (elements.btnCloseCaptureDocs) {
    elements.btnCloseCaptureDocs.addEventListener('click', () => collapseCapturePanel('documents'));
  }

  if (elements.btnExpandCaptureStaff) {
    elements.btnExpandCaptureStaff.addEventListener('click', () => expandCapturePanel('staff'));
  }
  if (elements.btnCloseCaptureStaff) {
    elements.btnCloseCaptureStaff.addEventListener('click', () => collapseCapturePanel('staff'));
  }

  // Invoice Input Source Toggle Event Listeners (View 1)
  if (elements.toggleCamera) {
    elements.toggleCamera.addEventListener('click', () => {
      elements.toggleCamera.classList.add('active');
      elements.toggleUpload.classList.remove('active');
      state.activeSource = 'camera';
      updateSourceVisibility();
      if (!state.capturedImageBase64) startCamera();
    });
  }
  if (elements.toggleUpload) {
    elements.toggleUpload.addEventListener('click', () => {
      elements.toggleUpload.classList.add('active');
      elements.toggleCamera.classList.remove('active');
      state.activeSource = 'upload';
      updateSourceVisibility();
      stopCamera();
    });
  }

  if (elements.btnPrevMonth) {
    elements.btnPrevMonth.addEventListener('click', () => {
      changeExpenseMonth(-1);
    });
  }
  if (elements.btnNextMonth) {
    elements.btnNextMonth.addEventListener('click', () => {
      changeExpenseMonth(1);
    });
  }
}

async function extractTextFromDocx(base64DataUrl) {
  try {
    const parts = base64DataUrl.split(';base64,');
    const base64Data = parts.length > 1 ? parts[1] : parts[0];
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const zip = await JSZip.loadAsync(bytes);
    const docFile = zip.file("word/document.xml");
    if (!docFile) {
      throw new Error("Could not find word/document.xml in the DOCX file.");
    }
    
    const docXmlText = await docFile.async("text");
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(docXmlText, "application/xml");
    
    const textNodes = xmlDoc.getElementsByTagName("w:t");
    let text = "";
    for (let i = 0; i < textNodes.length; i++) {
      text += textNodes[i].textContent + " ";
    }
    
    if (!text.trim()) {
      const fallbackNodes = xmlDoc.getElementsByTagName("t");
      for (let i = 0; i < fallbackNodes.length; i++) {
        text += fallbackNodes[i].textContent + " ";
      }
    }
    
    return text.trim();
  } catch (err) {
    console.error("Error extracting text from DOCX:", err);
    throw new Error("Неуспешно извличане на текст от Word файл. Моля, уверете се, че файлът не е повреден или го конвертирайте в PDF.");
  }
}

async function extractTextFromXlsx(base64DataUrl) {
  try {
    const parts = base64DataUrl.split(';base64,');
    const base64Data = parts.length > 1 ? parts[1] : parts[0];
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const zip = await JSZip.loadAsync(bytes);
    let text = "";
    
    // Extract shared strings
    const sharedStringsFile = zip.file("xl/sharedStrings.xml");
    if (sharedStringsFile) {
      const xmlText = await sharedStringsFile.async("text");
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "application/xml");
      const tNodes = xmlDoc.getElementsByTagName("t");
      for (let i = 0; i < tNodes.length; i++) {
        text += tNodes[i].textContent + " ";
      }
    }
    
    // Extract worksheet cell values
    const sheetFiles = zip.file(/xl\/worksheets\/sheet\d+\.xml/);
    for (const sheetFile of sheetFiles) {
      const xmlText = await sheetFile.async("text");
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "application/xml");
      const vNodes = xmlDoc.getElementsByTagName("v");
      for (let i = 0; i < vNodes.length; i++) {
        text += vNodes[i].textContent + " ";
      }
    }
    
    return text.trim();
  } catch (err) {
    console.error("Error extracting text from XLSX:", err);
    throw new Error("Неуспешно извличане на данни от Excel файл. Моля, конвертирайте го в PDF.");
  }
}

async function extractTextFromRtf(base64DataUrl) {
  try {
    const parts = base64DataUrl.split(';base64,');
    const base64Data = parts.length > 1 ? parts[1] : parts[0];
    const binaryString = window.atob(base64Data);
    
    let text = binaryString;
    
    // 1. Decode Unicode escapes: \uN followed by 1 placeholder character (or space)
    text = text.replace(/\\u(-?\d+)./g, (match, val) => {
      let code = parseInt(val, 10);
      if (code < 0) code += 65536;
      return String.fromCharCode(code);
    });
    
    // 2. Decode hex escapes: \'hh representing Windows-1251 bytes
    text = text.replace(/\\'[0-9a-fA-F]{2}/g, (match) => {
      const hex = match.substring(2);
      const byteVal = parseInt(hex, 16);
      if (byteVal >= 0xC0 && byteVal <= 0xFF) {
        return String.fromCharCode(0x0410 + (byteVal - 0xC0));
      }
      if (byteVal === 0xA8) return 'Ё';
      if (byteVal === 0xB8) return 'ё';
      if (byteVal === 0xAF) return 'І';
      if (byteVal === 0xBF) return 'і';
      if (byteVal === 0xBD) return 'Ї';
      if (byteVal === 0xBE) return 'ї';
      if (byteVal === 0xAA) return 'Є';
      if (byteVal === 0xBA) return 'є';
      if (byteVal === 0xA5) return 'Ґ';
      if (byteVal === 0xB4) return 'ґ';
      return String.fromCharCode(byteVal);
    });
    
    // 3. Remove group destinations (metadata, stylesheets, tables etc.)
    text = text.replace(/\{\\\*[^}]+\}/g, "");
    text = text.replace(/\{\\fonttbl[^}]+\}/g, "");
    text = text.replace(/\{\\colortbl[^}]+\}/g, "");
    text = text.replace(/\{\\stylesheet[^}]+\}/g, "");
    text = text.replace(/\{\\info[^}]+\}/g, "");
    
    // 4. Replace control words for paragraph breaks and tabs
    text = text.replace(/\\par\b/g, "\n");
    text = text.replace(/\\line\b/g, "\n");
    text = text.replace(/\\tab\b/g, " ");
    
    // 5. Remove any other control words
    text = text.replace(/\\(?:[a-zA-Z]+(-?\d+)?\s?|[-'\\])/g, " ");
    
    // 6. Remove remaining braces
    text = text.replace(/[{}]/g, "");
    
    // 7. Clean up whitespace
    text = text.replace(/[ ]+/g, " ");
    text = text.replace(/\n\s*\n+/g, "\n");
    
    return text.trim();
  } catch (err) {
    console.error("Error extracting text from RTF:", err);
    throw new Error("Неуспешно извличане на текст от RTF файл. Моля, уверете се, че файлът не е повреден или го конвертирайте в PDF.");
  }
}

async function prepareGeminiRequestBody(base64DataUrl, promptText, fileExtension) {
  const mimeTypeMatch = base64DataUrl.match(/data:([^;]+);base64,/);
  let mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/jpeg';
  const base64Data = base64DataUrl.split(',')[1];

  // Fallback / normalization based on file extension
  if (!mimeType || mimeType === 'application/octet-stream') {
    if (fileExtension === '.docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (fileExtension === '.xlsx') mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (fileExtension === '.doc') mimeType = 'application/msword';
    else if (fileExtension === '.xls') mimeType = 'application/vnd.ms-excel';
    else if (fileExtension === '.pdf') mimeType = 'application/pdf';
    else if (fileExtension === '.rtf') mimeType = 'application/rtf';
  }

  // 1. Handle DOCX
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
      mimeType.includes('wordprocessingml') || 
      fileExtension === '.docx') {
    const extractedText = await extractTextFromDocx(base64DataUrl);
    return {
      contents: [
        {
          parts: [
            {
              text: `${promptText}\n\nHere is the raw text content of the uploaded Word document:\n\"\"\"\n${extractedText}\n\"\"\"`
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
  }

  // 2. Handle XLSX
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
      mimeType.includes('spreadsheetml') || 
      fileExtension === '.xlsx') {
    const extractedText = await extractTextFromXlsx(base64DataUrl);
    return {
      contents: [
        {
          parts: [
            {
              text: `${promptText}\n\nHere is the raw text/string content extracted from the uploaded Excel spreadsheet:\n\"\"\"\n${extractedText}\n\"\"\"`
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
  }

  // 3. Handle RTF
  if (mimeType === 'application/rtf' || 
      mimeType === 'text/rtf' || 
      mimeType === 'text/richtext' || 
      fileExtension === '.rtf') {
    const extractedText = await extractTextFromRtf(base64DataUrl);
    return {
      contents: [
        {
          parts: [
            {
              text: `${promptText}\n\nHere is the raw text content of the uploaded RTF document:\n\"\"\"\n${extractedText}\n\"\"\"`
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
  }

  // 4. Handle old DOC / XLS
  if (mimeType === 'application/msword' || fileExtension === '.doc') {
    throw new Error('Форматът .doc (Word 97-2003) не се поддържа за директен анализ. Моля, запазете документа като .docx или го конвертирайте в PDF.');
  }
  if (mimeType === 'application/vnd.ms-excel' || fileExtension === '.xls') {
    throw new Error('Форматът .xls (Excel 97-2003) не се поддържа за директен анализ. Моля, запишете документа като .xlsx или го конвертирайте в PDF.');
  }

  // 5. Validate other types
  const supportedMimeTypes = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf', 'text/plain', 'text/csv', 'text/html', 'text/markdown',
    'application/rtf', 'text/rtf', 'text/richtext'
  ];
  
  const isSupported = supportedMimeTypes.some(t => mimeType.startsWith(t) || mimeType === t);
  if (!isSupported && !mimeType.startsWith('image/') && !mimeType.startsWith('text/')) {
    throw new Error(`Неподдържан файлов формат (${mimeType}). Моля, качете PDF, DOCX, XLSX, RTF, изображение или текстов файл.`);
  }

  // 6. Standard supported media/PDF type
  return {
    contents: [
      {
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };
}

// ==========================================
// Multi-File Upload & Sequential Processing
// ==========================================

/**
 * Read a single file as a base64 Data URL (returns a Promise).
 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error(`Неуспешно четене на файл: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Converts a local RTF or DOC File object to a PDF File object using the dev server API.
 * @param {File} file - The File object (.rtf or .doc).
 * @returns {Promise<File>} - Resolves with the converted PDF File object.
 */
function shouldConvertToPdf(file) {
  if (!file || !file.name) return false;
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  const convertFormats = ['.rtf', '.doc', '.xls', '.ppt', '.pptx', '.odt', '.ods', '.odp'];
  return convertFormats.includes(ext);
}

async function convertFileToPdf(file) {
  const apiKey = (state.cloudConvertApiKey || '').trim();
  if (!apiKey) {
    showSettingsPanelAndFocusCloudConvertKey();
    showToast('Моля, конфигурирайте първо вашия CloudConvert API ключ.', 'key');
    throw new Error('CloudConvert API key is not configured.');
  }

  const base64Data = await readFileAsDataURL(file);

  // User-selected target format for files Gemini can't read natively.
  const outputFormat = state.cloudConvertFormat === 'png' ? 'png' : 'pdf';

  const apiEndpoint = window.location.protocol === 'file:'
    ? `http://127.0.0.1:8080/api/convert-to-pdf`
    : '/api/convert-to-pdf';

  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: file.name,
      base64Data: base64Data,
      cloudConvertApiKey: apiKey,
      outputFormat: outputFormat
    })
  });

  if (!response.ok) {
    let errMsg = `Грешка при конвертиране (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson && errJson.error) errMsg = errJson.error;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const result = await response.json();
  if (!result.success || !result.base64Data) {
    throw new Error(result.error || 'Неизвестна грешка при конвертирането.');
  }

  const convertedBase64 = result.base64Data;
  const parts = convertedBase64.split(';base64,');
  const fallbackType = outputFormat === 'png' ? 'image/png' : 'application/pdf';
  const contentType = parts[0].split(':')[1] || fallbackType;
  const byteCharacters = atob(parts[1]);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: contentType });

  const lastDotIndex = file.name.lastIndexOf('.');
  const baseName = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex) : file.name;
  const convertedName = `${baseName}.${outputFormat}`;

  return new File([blob], convertedName, { type: contentType });
}


/**
 * Process multiple files sequentially.
 * For each file: load into state -> trigger transcription -> repeat.
 * @param {File[]} files - Array of File objects
 * @param {'invoices'|'docs'|'staff'} viewType - Which view to process for
 */
async function processMultipleFiles(files, viewType) {
  const apiKey = state.apiKey.trim();
  if (!apiKey) {
    showSettingsPanelAndFocusKey();
    return;
  }

  const total = files.length;
  showToast(`Обработка на ${total} файла...`, 'files');
  state.isProcessingMultipleFiles = true;

  // Determine which button to use for the loading indicator
  let btnElement;
  let transcribeFn;
  let handleFileFn;
  let stateBase64Key;
  let stateFileNameKey;
  let stateFileExtKey;

  if (viewType === 'invoices') {
    btnElement = elements.btnTranscribe;
    transcribeFn = transcribeDocument;
    handleFileFn = null; // We load manually
    stateBase64Key = 'capturedImageBase64';
    stateFileNameKey = 'capturedFileName';
    stateFileExtKey = 'capturedFileExtension';
  } else if (viewType === 'docs') {
    btnElement = elements.btnTranscribeDocs;
    transcribeFn = transcribeGeneralDocument;
    stateBase64Key = 'capturedImageBase64Docs';
    stateFileNameKey = 'capturedFileNameDocs';
    stateFileExtKey = 'capturedFileExtensionDocs';
  } else {
    btnElement = elements.btnTranscribeStaff;
    transcribeFn = transcribeStaffDocument;
    stateBase64Key = 'capturedImageBase64Staff';
    stateFileNameKey = 'capturedFileNameStaff';
    stateFileExtKey = 'capturedFileExtensionStaff';
  }

  // Save original button HTML
  const originalBtnHtml = btnElement.innerHTML;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const fileNum = i + 1;

    setAnalyzeProgress(viewType, fileNum, total);

    // Update the button to show progress
    btnElement.disabled = true;
    btnElement.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Файл ${fileNum}/${total}: ${escapeHTML(file.name.length > 25 ? file.name.substring(0, 22) + '...' : file.name)}</span>`;
    if (window.lucide) window.lucide.createIcons();

    try {
      let fileToProcess = file;
      if (shouldConvertToPdf(file)) {
        btnElement.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Конвертиране ${fileNum}/${total}: ${escapeHTML(file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name)}</span>`;
        if (window.lucide) window.lucide.createIcons();
        fileToProcess = await convertFileToPdf(file);
        
        btnElement.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Файл ${fileNum}/${total}: ${escapeHTML(fileToProcess.name.length > 25 ? fileToProcess.name.substring(0, 22) + '...' : fileToProcess.name)}</span>`;
        if (window.lucide) window.lucide.createIcons();
      }

      const base64Data = await readFileAsDataURL(fileToProcess);

      const lastDotIndex = fileToProcess.name.lastIndexOf('.');
      state[stateFileNameKey] = lastDotIndex !== -1 ? fileToProcess.name.substring(0, lastDotIndex) : fileToProcess.name;
      state[stateFileExtKey] = lastDotIndex !== -1 ? fileToProcess.name.substring(lastDotIndex).toLowerCase() : '';
      state[stateBase64Key] = base64Data;

      await transcribeFn();
      successCount++;
    } catch (err) {
      console.error(`Error processing file "${file.name}":`, err);
      failCount++;
      showToast(`Грешка с "${file.name}": ${err.message}`, 'alert-circle');
    }
  }

  // Restore batch flag and button
  state.isProcessingMultipleFiles = false;
  hideAnalyzeProgress(viewType);
  btnElement.disabled = false;
  btnElement.innerHTML = originalBtnHtml;
  if (window.lucide) window.lucide.createIcons();

  // Collapse capture panel now that all files are analyzed
  if (viewType === 'invoices') {
    collapseCapturePanel('invoices');
  } else if (viewType === 'docs') {
    collapseCapturePanel('documents');
  } else {
    collapseCapturePanel('staff');
  }

  // Final summary toast
  if (failCount === 0) {
    showToast(`Успешно обработени ${successCount} от ${total} файла!`, 'check-circle');
  } else {
    showToast(`Обработени ${successCount}/${total} файла (${failCount} с грешка).`, 'alert-triangle');
  }
}


// File Reader Helper
function handleFile(file) {
  if (shouldConvertToPdf(file)) {
    elements.imagePreview.src = '';
    elements.imagePreview.classList.add('hidden');
    elements.btnRotatePreview.classList.add('hidden');
    
    const existingPlaceholder = document.getElementById('pdf-preview-placeholder');
    if (existingPlaceholder) {
      existingPlaceholder.remove();
    }
    
    const placeholder = document.createElement('div');
    placeholder.id = 'pdf-preview-placeholder';
    placeholder.className = 'document-preview-placeholder';
    placeholder.innerHTML = `
      <div class="doc-placeholder-icon">
        <i data-lucide="loader-2" class="animate-spin"></i>
      </div>
      <div class="doc-placeholder-info">
        <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
        <div class="doc-placeholder-size">Конвертиране в ${state.cloudConvertFormat === 'png' ? 'PNG' : 'PDF'}...</div>
      </div>
    `;
    
    elements.previewContainer.appendChild(placeholder);
    elements.previewContainer.classList.remove('hidden');
    elements.btnTranscribe.disabled = true;
    
    if (window.lucide) {
      window.lucide.createIcons();
    }
    
    convertFileToPdf(file)
      .then(pdfFile => {
        handleFile(pdfFile);
      })
      .catch(err => {
        const formatName = file.name.substring(file.name.lastIndexOf('.')).toUpperCase().substring(1);
        showToast(`Грешка при конвертиране на ${formatName}: ${err.message}`, 'alert-circle');
        resetPreview();
      });
    return;
  }

  const lastDotIndex = file.name.lastIndexOf('.');
  state.capturedFileName = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex) : file.name;
  state.capturedFileExtension = lastDotIndex !== -1 ? file.name.substring(lastDotIndex).toLowerCase() : '';

  const reader = new FileReader();
  reader.onload = (e) => {
    if (file.type.startsWith('image/')) {
      processAndPreviewImage(e.target.result);
    } else {
      state.capturedImageBase64 = e.target.result;
      
      elements.imagePreview.src = '';
      elements.imagePreview.classList.add('hidden');
      elements.btnRotatePreview.classList.add('hidden');
      
      const existingPlaceholder = document.getElementById('pdf-preview-placeholder');
      if (existingPlaceholder) {
        existingPlaceholder.remove();
      }
      
      const iconName = getIconForMime(e.target.result);
      
      const placeholder = document.createElement('div');
      placeholder.id = 'pdf-preview-placeholder';
      placeholder.className = 'document-preview-placeholder';
      
      const fileSizeFormatted = file.size > 1024 * 1024 
        ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
        : (file.size / 1024).toFixed(1) + ' KB';
        
      placeholder.innerHTML = `
        <div class="doc-placeholder-icon">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="doc-placeholder-info">
          <div class="doc-placeholder-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
          <div class="doc-placeholder-size">${fileSizeFormatted}</div>
        </div>
      `;
      
      elements.previewContainer.appendChild(placeholder);
      elements.previewContainer.classList.remove('hidden');

      if (window.lucide) {
        window.lucide.createIcons();
      }
      transcribeDocument(); // auto-start analysis
    }
  };
  reader.readAsDataURL(file);
}

// Helper to open PDF/Word/Excel base64 content in new tab
function openBase64InNewTab(base64DataUrl, fileName) {
  try {
    const parts = base64DataUrl.split(';base64,');
    if (parts.length < 2) return;
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    const blob = new Blob([uInt8Array], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
  } catch (e) {
    console.error("Failed to open file in new tab", e);
    const newTab = window.open();
    if (newTab) {
      newTab.document.write(`<iframe src="${base64DataUrl}" frameborder="0" style="border:0; top:0px; left:0px; bottom:0px; right:0px; width:100%; height:100%;" allowfullscreen></iframe>`);
    }
  }
}

// Get icon name based on mime type or file path
function getIconForMime(base64Str) {
  if (!base64Str) return 'file-text';
  if (base64Str.startsWith('data:application/pdf')) return 'file-text';
  if (base64Str.includes('word') || base64Str.includes('officedocument.word') || base64Str.endsWith('.doc') || base64Str.endsWith('.docx')) return 'file-text';
  if (base64Str.includes('excel') || base64Str.includes('spreadsheet') || base64Str.includes('officedocument.spreadsheet') || base64Str.endsWith('.xls') || base64Str.endsWith('.xlsx') || base64Str.endsWith('.csv')) return 'file-spreadsheet';
  return 'file-text';
}

// ==========================================
// Toast & Utility Functions
// ==========================================

let toastTimeout;
function showToast(message, iconName = 'info') {
  clearTimeout(toastTimeout);
  
  elements.toastMessage.textContent = message;
  elements.toastIcon.setAttribute('data-lucide', iconName);
  
  if (window.lucide) window.lucide.createIcons();
  
  elements.toast.classList.remove('hidden');
  
  toastTimeout = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 4000);
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// ==========================================
// Backup & Restore Functions
// ==========================================

async function backupDataZip() {
  if (typeof JSZip === 'undefined') {
    showToast('Архивиращата библиотека (JSZip) все още се зарежда...', 'alert-triangle');
    return;
  }

  const originalHtml = elements.btnBackup.innerHTML;
  elements.btnBackup.disabled = true;
  elements.btnBackup.innerHTML = `<i data-lucide="loader-2" class="animate-spin"></i> <span>Архивиране...</span>`;
  if (window.lucide) window.lucide.createIcons();

  try {
    const zip = new JSZip();
    const backupObj = {
      saved_documents: state.documents,
      saved_general_documents: state.generalDocs,
      saved_staff: state.staff,
      saved_staff_general_documents: state.staffGeneralDocs,
      gemini_api_key: state.apiKey,
      cloudconvert_api_key: state.cloudConvertApiKey,
      cloudconvert_format: state.cloudConvertFormat,
      theme: state.theme,
      my_company_name: state.myCompany
    };

    zip.file("backup_data.json", JSON.stringify(backupObj, null, 2));

    // Bundle the actual uploaded files referenced by the data. The data only
    // stores "uploads/<name>" URL references now, so without this the backup
    // would not contain the images/PDFs at all.
    const urls = collectUploadUrls();
    let bundled = 0;
    let missing = 0;
    for (const url of urls) {
      try {
        const resp = await fetch(resolveUploadUrl(url));
        if (resp.ok) {
          zip.file(url, await resp.blob()); // stored at "uploads/<name>"
          bundled++;
        } else {
          missing++;
        }
      } catch (err) {
        missing++;
        console.warn('Backup: could not fetch', url, err);
      }
    }

    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    const dateStr = new Date().toISOString().slice(0, 10);
    link.download = `docuscribe_backup_${dateStr}.zip`;
    link.click();

    if (missing > 0) {
      showToast(`Архивът е създаден (${bundled} файла; ${missing} липсват).`, 'alert-triangle');
    } else {
      showToast(`Архивът е създаден успешно (${bundled} файла).`, 'check-circle');
    }
  } catch (err) {
    console.error(err);
    showToast('Грешка при архивиране.', 'alert-circle');
  } finally {
    elements.btnBackup.disabled = false;
    elements.btnBackup.innerHTML = originalHtml;
    if (window.lucide) window.lucide.createIcons();
  }
}

function handleRestoreFile(file) {
  if (typeof JSZip === 'undefined') {
    showToast('Архивиращата библиотека (JSZip) все още се зарежда...', 'alert-triangle');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(evt) {
    JSZip.loadAsync(evt.target.result).then((zip) => {
      const backupJsonFile = zip.file("backup_data.json");
      if (!backupJsonFile) {
        showToast('Невалиден архив: липсва backup_data.json.', 'alert-triangle');
        return;
      }
      
      backupJsonFile.async("string").then((jsonStr) => {
        try {
          const data = JSON.parse(jsonStr);
          if (data && Array.isArray(data.saved_documents)) {
            const docLen = data.saved_documents.length;
            const docGenLen = Array.isArray(data.saved_general_documents) ? data.saved_general_documents.length : 0;
            const staffLen = Array.isArray(data.saved_staff) ? data.saved_staff.length : 0;
            const staffGenLen = Array.isArray(data.saved_staff_general_documents) ? data.saved_staff_general_documents.length : 0;
            const confirmMsg = `Потвърдете възстановяването на:\n- ${docLen} фактури/бележки\n- ${docGenLen} общи документи\n- ${staffLen} досиета на служители\n- ${staffGenLen} общи документи на служители\nНастоящите ви данни ще бъдат презаписани!`;
            
            if (confirm(confirmMsg)) {
              localStorage.setItem('saved_documents', JSON.stringify(data.saved_documents));
              
              const restoredGeneralDocs = data.saved_general_documents || [];
              const restoredStaff = data.saved_staff || [];
              const restoredStaffGeneralDocs = data.saved_staff_general_documents || [];
              
              localStorage.setItem('saved_general_documents', JSON.stringify(restoredGeneralDocs));
              localStorage.setItem('saved_staff', JSON.stringify(restoredStaff));
              localStorage.setItem('saved_staff_general_documents', JSON.stringify(restoredStaffGeneralDocs));
              
              if (data.gemini_api_key !== undefined) {
                localStorage.setItem('gemini_api_key', data.gemini_api_key);
              }
              if (data.cloudconvert_api_key !== undefined) {
                localStorage.setItem('cloudconvert_api_key', data.cloudconvert_api_key);
              }
              if (data.cloudconvert_format !== undefined) {
                localStorage.setItem('cloudconvert_format', data.cloudconvert_format);
              }
              if (data.theme !== undefined) {
                localStorage.setItem('theme', data.theme);
              }
              if (data.my_company_name !== undefined) {
                localStorage.setItem('my_company_name', data.my_company_name);
              }
              
              // Refresh state
              state.documents = data.saved_documents;
              state.generalDocs = restoredGeneralDocs;
              state.staff = restoredStaff;
              state.staffGeneralDocs = restoredStaffGeneralDocs;
              state.apiKey = data.gemini_api_key || '';
              state.cloudConvertApiKey = data.cloudconvert_api_key || '';
              state.cloudConvertFormat = data.cloudconvert_format || 'pdf';
              state.theme = data.theme || 'dark';
              state.myCompany = data.my_company_name || '';
              
              // Apply changes
              applyTheme();
              updateApiKeyBadge();
              updateCloudConvertApiKeyBadge();
              if (elements.cloudConvertApiKeyInput) {
                elements.cloudConvertApiKeyInput.value = state.cloudConvertApiKey;
              }
              if (elements.cloudConvertFormatSelect) {
                elements.cloudConvertFormatSelect.value = state.cloudConvertFormat;
              }
              elements.headerCompanyInput.value = state.myCompany;
              migrateOldDocuments();
              renderDocumentList();
              renderGeneralDocumentList();
              renderStaffList();
              renderStaffGeneralDocsList();

              // Write the bundled upload files back into the server's uploads/
              // folder (preserving names) so the "uploads/<name>" references in
              // the restored data resolve again. Older JSON-only backups have no
              // such entries, so this is a no-op for them.
              restoreUploadsFromZip(zip).then((res) => {
                if (res.total > 0) {
                  // Re-render so the just-written files load fresh (their <img>
                  // may have 404'd before the files were written).
                  renderDocumentList();
                  renderGeneralDocumentList();
                  renderStaffList();
                  renderStaffGeneralDocsList();
                }
                if (res.total > 0 && res.restored < res.total) {
                  showToast(`Данните са възстановени; записани са ${res.restored}/${res.total} файла на сървъра.`, 'alert-triangle');
                } else {
                  showToast('Данните са възстановени успешно!', 'check-circle');
                }
              });
            }
          } else {
            showToast('Невалидна структура на архивните данни.', 'alert-triangle');
          }
        } catch (err) {
          console.error(err);
          showToast('Грешка при парсване на архивния файл.', 'alert-circle');
        }
      });
    }).catch(err => {
      console.error(err);
      showToast('Грешка при декомпресиране на ZIP архива.', 'alert-circle');
    });
  };
  reader.readAsArrayBuffer(file);
}

function changeExpenseMonth(direction) {
  let [year, month] = state.activeExpenseMonth.split('-').map(Number);
  month += direction;
  if (month < 1) {
    month = 12;
    year -= 1;
  } else if (month > 12) {
    month = 1;
    year += 1;
  }
  state.activeExpenseMonth = year + '-' + String(month).padStart(2, '0');
  updateMonthlyExpenseTotal();
}

function updateMonthlyExpenseTotal() {
  if (!elements.monthlyExpenseSummary || !elements.monthlyExpenseLabel || !elements.monthlyExpenseValue) return;
  
  const monthNamesBG = [
    'Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни',
    'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'
  ];
  
  const [year, month] = state.activeExpenseMonth.split('-').map(Number);
  const bgMonthName = monthNamesBG[month - 1] + ' ' + year;
  elements.monthlyExpenseLabel.textContent = `Общо разходи (${bgMonthName}):`;
  
  const expenseTypes = ['invoice', 'bills', 'receipt', 'taxes', 'other'];
  let monthlyTotal = 0;
  
  state.documents.forEach(doc => {
    if (expenseTypes.includes(doc.type)) {
      const docDate = normalizeDate(doc.date);
      if (docDate && docDate.startsWith(state.activeExpenseMonth)) {
        if (doc.totalAmount != null) {
          monthlyTotal += Number(doc.totalAmount);
        }
      }
    }
  });
  
  elements.monthlyExpenseValue.textContent = `${monthlyTotal.toFixed(2)} €`;
}

// PIN Authentication Logic
function initPINAuthentication() {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;

  // If already authenticated this session, do nothing.
  if (sessionStorage.getItem('authenticated') === 'true') {
    overlay.classList.add('hidden');
    return;
  }

  // The PIN is validated against the server (it's the shared sync credential),
  // so a fresh device may not know its length — ask the server, fall back local.
  const localLen = (localStorage.getItem('app_access_pin') || '1234').length;
  fetch(syncEndpoint('/api/auth-info'))
    .then((r) => r.json())
    .then((info) => buildPinPad(info && info.pinLength ? info.pinLength : localLen))
    .catch(() => buildPinPad(localLen));

  function grantAccess() {
    overlay.classList.add('hidden');
    showToast('Успешен достъп!', 'check-circle');
    const isMobile = window.innerWidth < 768;
    const activePanel = state.activePage === 'invoices' ? elements.capturePanelInvoices : (state.activePage === 'documents' ? elements.capturePanelDocs : elements.capturePanelStaff);
    const activeSrc = state.activePage === 'invoices' ? state.activeSource : (state.activePage === 'documents' ? state.activeSourceDocs : state.activeSourceStaff);
    if (activeSrc === 'camera' && activePanel && (!activePanel.classList.contains('hidden') || isMobile)) {
      startCamera();
    }
  }

  function buildPinPad(targetLength) {
    const dotsContainer = overlay.querySelector('.pin-dots');
    if (dotsContainer) {
      dotsContainer.innerHTML = '';
      for (let i = 0; i < targetLength; i++) {
        const span = document.createElement('span');
        span.classList.add('pin-dot');
        dotsContainer.appendChild(span);
      }
    }

    let enteredPIN = '';
    let checking = false;
    const dots = overlay.querySelectorAll('.pin-dot');
    const keys = overlay.querySelectorAll('.pin-key');
    const card = overlay.querySelector('.auth-card');

    function updateDots() {
      dots.forEach((dot, index) => {
        if (index < enteredPIN.length) dot.classList.add('active');
        else dot.classList.remove('active');
      });
    }

    function rejectPin() {
      card.classList.add('shake');
      showToast('Грешен PIN код!', 'alert-triangle');
      setTimeout(() => {
        card.classList.remove('shake');
        enteredPIN = '';
        updateDots();
      }, 600);
    }

    // Validate the PIN against the server. The same load-state call returns the
    // shared dataset, so a correct login also pulls everything in one round-trip.
    async function submitPin() {
      checking = true;
      const pin = enteredPIN;
      let r, result;
      try {
        r = await fetch(syncEndpoint('/api/load-state'), { headers: { 'X-Sync-Token': pin } });
        result = await r.json();
      } catch (e) {
        // Offline: fall back to the locally cached PIN.
        const localPin = localStorage.getItem('app_access_pin') || '1234';
        if (pin === localPin) {
          sessionStorage.setItem('authenticated', 'true');
          grantAccess();
          showSyncError('Офлайн режим: няма връзка със сървъра.');
        } else {
          rejectPin();
        }
        checking = false;
        return;
      }
      if (r.ok && result && result.success) {
        localStorage.setItem('app_access_pin', pin); // cache for offline + use as sync token
        sessionStorage.setItem('authenticated', 'true');
        applyServerData(result.data);
        hideSyncError();
        grantAccess();
      } else {
        rejectPin();
      }
      checking = false;
    }

    function handleKeyPress(val) {
      if (checking || card.classList.contains('shake')) return;
      if (val === 'clear') enteredPIN = '';
      else if (val === 'delete') enteredPIN = enteredPIN.slice(0, -1);
      else if (enteredPIN.length < targetLength) enteredPIN += val;
      updateDots();
      if (enteredPIN.length === targetLength) submitPin();
    }

    keys.forEach((key) => {
      key.addEventListener('click', () => handleKeyPress(key.dataset.val));
    });

    document.addEventListener('keydown', (e) => {
      if (overlay.classList.contains('hidden') || sessionStorage.getItem('authenticated') === 'true') return;
      if (e.key >= '0' && e.key <= '9') handleKeyPress(e.key);
      else if (e.key === 'Backspace') handleKeyPress('delete');
      else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') handleKeyPress('clear');
    });
  }
}

// Boot application
document.addEventListener('DOMContentLoaded', init);
