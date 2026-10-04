// Restore each system's visual language before first paint.
try {
  const system = localStorage.getItem('admin-system') === 'arena' ? 'arena' : 'gallery';
  document.documentElement.dataset.system = system;
  document.documentElement.dataset.theme = localStorage.getItem(`admin-theme-${system}`)
    || (system === 'gallery' ? localStorage.getItem('admin-theme') || 'dark' : 'light');
} catch { /* private mode */ }
