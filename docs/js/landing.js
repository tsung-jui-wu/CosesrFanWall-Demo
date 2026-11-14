import { api, toast } from './api.js';

// Every event needs an invite code from the site owner, so the code field is always there.
const form = document.getElementById('create');

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
        key: document.getElementById('key').value,
      },
    });
    location.href = `${adminPath}?new=1`;
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
  }
});
