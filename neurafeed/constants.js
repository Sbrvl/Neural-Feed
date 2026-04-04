// Shared message action names for Chrome extension message passing.
// Always use these constants — never hardcode strings.
// Silent bugs caused by string drift are the #1 MV3 extension failure mode.

const ACTIONS = {
  // Existing capture actions (used by offscreen.js ↔ service_worker.js)
  START_CAPTURE:    'startCapture',
  STOP_CAPTURE:     'stopCapture',
  CAPTURE_READY:    'captureReady',
  CAPTURE_RESULT:   'captureResult',
  CAPTURE_ERROR:    'captureError',
  ANALYSIS_COMPLETE:'analysisComplete',
  ANALYSIS_ERROR:   'analysisError',
  OPEN_SIDE_PANEL:  'openSidePanel',
  // Session mode actions (used by popup.js ↔ service_worker.js ↔ content.js)
  START_SESSION:    'startSession',
  STOP_SESSION:     'stopSession',
  REEL_CHANGED:     'reelChanged',
  SESSION_UPDATE:   'sessionUpdate',
  GET_SESSION_STATE:'getSessionState',
};

// Alarm name used by chrome.alarms keepalive during capture
const ALARM_KEEPALIVE = 'captureKeepalive';

// FIFO queue max depth — oldest reel dropped when full
const QUEUE_MAX_DEPTH = 3;

// AWS EC2 endpoint (http — extension service workers are exempt from mixed-content rules)
const HF_SPACE_URL = 'http://3.144.178.72:7860';
const HF_API_KEY = 'mysecretkey';

// Brain rot score thresholds
const SCORE_THRESHOLDS = {
  GREEN_MAX: 4,
  YELLOW_MAX: 7,
};

// Timeseries animation playback speed (~2fps to match fMRI TR)
const ANIMATION_FPS = 2;
