import { api, toast } from './api.js';

const form = document.getElementById('create');

api('/api/config').then((cfg) => {
  if (cfg.needsKey) {
    document.getElementById('key-field').hidden = false;
    document.getElementById('key').required = true;
  }
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const { adminPath } = await api('/api/events', {
      method: 'POST',
      json: {
        // Read by id: form.name is the form's own name attribute, not the input.
        name: document.getElementById('name').value,
        retentionDays: Number(document.getElementById('retention').value),
        key: document.getElementById('key').value || undefined,
      },
    });
    location.href = `${adminPath}?new=1`;
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
  }
});
