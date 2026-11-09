const out = document.querySelector('#out');
const codeInput = document.querySelector('#code');
const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('c');
if (fromHash) codeInput.value = fromHash;

function show(text) { out.textContent = text; }

document.querySelector('#lookup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  const response = await fetch(`/api/batch/device/${encodeURIComponent(code)}`, { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) { show(data.error || '无法查看这批计划'); return; }
  out.replaceChildren();
  const digest = document.createElement('pre');
  digest.textContent = data.payloadDigest;
  const list = document.createElement('ul');
  for (const work of data.works ?? []) {
    const item = document.createElement('li');
    item.textContent = `${work.key} · ${work.task} · ${work.title || '未命名'} · ${work.compressedBytes} 字节`;
    list.append(item);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '确认这一批的完整摘要';
  button.addEventListener('click', async () => {
    const approved = await fetch(`/api/batch/${encodeURIComponent(data.batchId)}/approve`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code, payloadDigest: data.payloadDigest }),
    });
    const result = await approved.json();
    show(approved.ok ? `已确认 ${result.payloadDigest}` : (result.error || '确认失败'));
  });
  out.append('完整摘要：', digest, list, button);
});
