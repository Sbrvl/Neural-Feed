// Shared message action names for Chrome extension message passing.
// Always use these constants — never hardcode strings.
// Silent bugs caused by string drift are the #1 MV3 extension failure mode.

const ACTIONS = {
  START_CAPTURE: 'startCapture',
  STOP_CAPTURE: 'stopCapture',
  CAPTURE_READY: 'captureReady',
  CAPTURE_RESULT: 'captureResult',
  CAPTURE_ERROR: 'captureError',
  ANALYSIS_COMPLETE: 'analysisComplete',
  ANALYSIS_ERROR: 'analysisError',
  OPEN_SIDE_PANEL: 'openSidePanel',
};

// Alarm name used by chrome.alarms keepalive during capture
const ALARM_KEEPALIVE = 'captureKeepalive';

// FIFO queue max depth — oldest reel dropped when full
const QUEUE_MAX_DEPTH = 3;

// HuggingFace Space endpoint
// Replace with your actual Space URL
const HF_SPACE_URL = 'https://YOUR_USERNAME-neurafeed.hf.space';
const HF_API_KEY = 'REPLACE_WITH_YOUR_API_KEY'; // Set this after rotating your token

// Brain rot score thresholds
const SCORE_THRESHOLDS = {
  GREEN_MAX: 4,
  YELLOW_MAX: 7,
};

// Timeseries animation playback speed (~2fps to match fMRI TR)
const ANIMATION_FPS = 2;
