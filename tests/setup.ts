import '@testing-library/jest-dom/vitest';

// jsdom does not implement native dialog opening; browser tests cover focus and modality.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
}
