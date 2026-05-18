/*
  sleepy-bins.js — UI Look Test
  ==============================
  Replaces all 3 bin images with sleepy versions. Click a bin to go inside.

  How to use:
    1. npm run dev → opens http://127.0.0.1:5174
    2. F12 → Console → paste this file → Enter
    3. Click any bin to go inside
*/

(function () {
  var buttons = document.querySelectorAll('.bin-button');
  if (!buttons.length) {
    console.warn('sleepy-bins: no .bin-button found. Are you on the home page?');
    return;
  }

  var count = 0;
  var sleepyFiles = ['emergency-sleepy.png', 'info-bin-sleepy.png', 'maybe-bin-sleepy.png'];

  buttons.forEach(function (btn, idx) {
    var img = btn.querySelector('img');
    if (!img) return;

    var src = (img.getAttribute('src') || '');
    // Extract directory path from current src
    var slash = src.lastIndexOf('/');
    if (slash === -1) return;
    var dir = src.slice(0, slash + 1);
    img.setAttribute('src', dir + sleepyFiles[idx]);
    count++;
  });

  console.log('sleepy-bins: replaced ' + count + ' bin images with sleepy versions. Bins still clickable.');
})();
