/*
  open-bin.js — UI Look Test
  ===========================
  What it does:
    Clicks a bin and navigates to its folder view. If the bin is empty,
    the sleepy empty state appears. Click the sleepy image to see the
    floating "Shh..." toast drift upward and fade.

  How to use:
    1. Start the app: npm run dev (opens http://127.0.0.1:5174)
    2. Open browser DevTools (F12 → Console)
    3. Copy-paste this entire file into the console and press Enter
    4. Watch it navigate to the Emergency bin
    5. Click the sleepy image to see the floating message
*/

(function () {
  var binButton = document.querySelector('.bin-emergency');
  if (!binButton) {
    console.warn('open-bin: No .bin-emergency button found. Are you on the home page?');
    return;
  }

  binButton.click();
  console.log('open-bin: Navigated to Emergency bin. Click the sleepy image to see the toast.');
})();
