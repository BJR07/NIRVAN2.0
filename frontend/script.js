// script.js - robust replacement (works with the HTML you posted)
'use strict';

const audioFileInput = document.getElementById('audioFile');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const recordButton = document.getElementById('recordButton');
const analyzeBtn = document.getElementById('analyzeBtn');
const audioPlayer = document.getElementById('audioPlayer');
const fileName = document.getElementById('fileName');
const sceneDescriptionBox = document.getElementById('sceneDescriptionBox');
const transcriptionText = document.getElementById('transcriptionText'); // may exist in HTML
const eventsGrid = document.getElementById('eventsGrid'); // list area in your HTML
const eventsCount = document.getElementById('eventsCount'); // count area
const errorMessage = document.getElementById('errorMessage');

// fallback container if your HTML uses a different id
const detectedSoundsBox = document.getElementById('detectedSounds') || eventsGrid || null;

let mediaRecorder = null;
let isRecording = false;
let audioChunks = [];

// safety checks for required elements
if (!analyzeBtn) console.error('analyzeBtn element not found');
if (!sceneDescriptionBox) console.error('sceneDescriptionBox element not found');
if (!audioFileInput) console.error('audioFile input not found');

chooseFileBtn?.addEventListener('click', () => audioFileInput.click());
audioFileInput?.addEventListener('change', handleFileSelect);
recordButton?.addEventListener('click', toggleRecording);
analyzeBtn?.addEventListener('click', analyzeAudio);

// set initial UI state
hideError();

function handleFileSelect(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  fileName.textContent = f.name || `Selected: ${f.name}`;
  // create object url and assign for playback
  audioPlayer.src = URL.createObjectURL(f);
  audioPlayer.style.display = 'block';
  // clear prior results
  clearResults();
}

function toggleRecording() {
  if (!isRecording) startRecording();
  else stopRecording();
}

function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('Microphone not supported in this browser.');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = ev => audioChunks.push(ev.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        // show recorded audio in player
        audioPlayer.src = URL.createObjectURL(blob);
        audioPlayer.style.display = 'block';
        fileName.textContent = `recording_${Date.now()}.webm`;
        // set the file input (so analyzeAudio will prioritize file input)
        try {
          const dt = new DataTransfer();
          const recordedFile = new File([blob], `recording_${Date.now()}.webm`, { type: blob.type });
          dt.items.add(recordedFile);
          audioFileInput.files = dt.files;
        } catch (e) {
          console.warn('Could not populate file input with recording (browser limitation)', e);
        }
        // stop tracks
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      isRecording = true;
      recordButton.textContent = 'Stop Recording';
      // small visual hint
      recordButton.classList.add('recording');
      hideError();
    })
    .catch(err => showError('Could not access microphone: ' + (err.message || err)));
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    recordButton.textContent = 'Start Recording';
    recordButton.classList.remove('recording');
  }
}

async function analyzeAudio() {
  hideError();
  clearResults();
  if (!sceneDescriptionBox) {
    console.error('No sceneDescriptionBox element found — cannot display results.');
  } else {
    sceneDescriptionBox.textContent = 'Analyzing...';
  }

  // determine audio blob
  let audioBlob = null;
  try {
    if (audioFileInput && audioFileInput.files && audioFileInput.files.length > 0) {
      audioBlob = audioFileInput.files[0];
      console.log('Using audio from file input:', audioBlob.name, audioBlob.type);
    } else if (audioPlayer && audioPlayer.src) {
      // attempt fetch of object URL (works for object URLs and remote URLs)
      const response = await fetch(audioPlayer.src);
      audioBlob = await response.blob();
      console.log('Using audio from audioPlayer.src (fetched blob). type:', audioBlob.type);
    } else {
      showError('Please upload or record an audio file first.');
      if (sceneDescriptionBox) sceneDescriptionBox.textContent = '';
      return;
    }
  } catch (err) {
    showError('Failed to read audio: ' + (err.message || err));
    if (sceneDescriptionBox) sceneDescriptionBox.textContent = '';
    return;
  }

  // prepare form data
  const ext = guessExtensionFromType(audioBlob.type) || 'wav';
  const filename = `input_audio.${ext}`;
  const fd = new FormData();
  fd.append('file', audioBlob, filename);

  // call backend
  try {
    console.log('Sending audio to backend...');
    const res = await fetch('http://127.0.0.1:8000/transcribe', {
      method: 'POST',
      body: fd
    });

    console.log('Server status:', res.status);
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errMsg = (data && (data.error || JSON.stringify(data))) || `Server returned status ${res.status}`;
      showError(errMsg);
      if (sceneDescriptionBox) sceneDescriptionBox.textContent = '';
      return;
    }

    console.log('Server response:', data);
    // display transcription / description
    const text = data.transcription || data.text || data.result || '(no transcription)';
    if (sceneDescriptionBox) sceneDescriptionBox.textContent = text;
    if (transcriptionText) transcriptionText.textContent = text;

    // display detected sounds
    // expected format from backend: detected_sounds: [{label: 'Speech', score: 0.81}, ...] OR array of strings
    if (data.detected_sounds) {
      renderDetectedSounds(data.detected_sounds);
    } else if (data.detected_sounds_list) {
      renderDetectedSounds(data.detected_sounds_list);
    } else if (data.events) {
      renderDetectedSounds(data.events);
    } else {
      // nothing from backend — show placeholder
      if (eventsCount) eventsCount.textContent = '(No non-speech events returned)';
      if (eventsGrid) eventsGrid.innerHTML = '';
    }

  } catch (err) {
    showError('Network or server error: ' + (err.message || err));
    if (sceneDescriptionBox) sceneDescriptionBox.textContent = '';
    console.error(err);
  }
}

function renderDetectedSounds(list) {
  // list may be array of strings or array of {label, score} or {name,score}
  if (!list || !Array.isArray(list)) {
    if (eventsCount) eventsCount.textContent = '(No events)';
    return;
  }

  // clear
  if (eventsGrid) eventsGrid.innerHTML = '';
  if (eventsCount) eventsCount.textContent = `${list.length} audio elements detected`;

  list.forEach(item => {
    let label = '', score = null;
    if (typeof item === 'string') label = item;
    else if (item && (item.label || item.name)) {
      label = item.label || item.name;
      score = item.score ?? item.confidence ?? item.probability ?? null;
    } else if (item && typeof item === 'object') {
      // try first key -> value
      const k = Object.keys(item)[0];
      label = `${k}: ${item[k]}`;
    } else {
      label = String(item);
    }

    const li = document.createElement('li');
    li.className = 'event-item';
    if (score !== null && !Number.isNaN(Number(score))) {
      li.innerHTML = `<span class="event-label">${escapeHtml(label)}</span> <span class="score">(${Number(score).toFixed(3)})</span>`;
    } else {
      li.textContent = label;
    }
    if (eventsGrid) eventsGrid.appendChild(li);
  });
}

// small helpers
function showError(msg) {
  console.error(msg);
  if (errorMessage) {
    errorMessage.textContent = msg;
    errorMessage.style.display = 'block';
  } else {
    alert(msg);
  }
}
function hideError() {
  if (errorMessage) {
    errorMessage.textContent = '';
    errorMessage.style.display = 'none';
  }
}
function clearResults() {
  if (sceneDescriptionBox) sceneDescriptionBox.textContent = '';
  if (transcriptionText) transcriptionText.textContent = '(No transcription yet)';
  if (eventsGrid) eventsGrid.innerHTML = '';
  if (eventsCount) eventsCount.textContent = '';
}
function guessExtensionFromType(mime) {
  if (!mime) return null;
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return null;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
