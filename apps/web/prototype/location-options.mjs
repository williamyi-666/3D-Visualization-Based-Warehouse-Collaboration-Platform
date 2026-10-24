// 仓库名称和编码只作为文本/属性写入，不能进入 HTML 模板。
export function setLocationOptions(select, rows) {
  const doc = select.ownerDocument;
  select.replaceChildren(...rows.map(row => {
    const option = doc.createElement('option');
    option.value = row.loc_code;
    option.textContent = row.name;
    return option;
  }));
}

export function setLocationChoices(container, options, current, kind, emptyText) {
  const doc = container.ownerDocument;
  const nodes = options.map(option => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'lp-item' + (option.value === current ? ' on' : '');
    button.dataset[kind] = option.value;
    button.textContent = option.textContent;
    return button;
  });
  if (!nodes.length) {
    const empty = doc.createElement('div');
    empty.className = 'lp-empty';
    empty.textContent = emptyText;
    nodes.push(empty);
  }
  container.replaceChildren(...nodes);
}
