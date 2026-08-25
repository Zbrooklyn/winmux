import { App, Modal, Setting } from 'obsidian';

export class RenameModal extends Modal {
  constructor(app: App, private value: string, private onSubmit: (v: string) => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    this.setTitle('Rename terminal');
    let v = this.value;
    const s = new Setting(contentEl).setName('Name').addText(t => {
      t.setValue(v).onChange(x => v = x);
      t.inputEl.style.width = '100%';
      t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.onSubmit(v); this.close(); } });
      setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 30);
    });
    s.settingEl.addClass('winmux-rename-row');
    new Setting(contentEl)
      .addButton(b => b.setButtonText('Rename').setCta().onClick(() => { this.onSubmit(v); this.close(); }))
      .addButton(b => b.setButtonText('Use automatic name').onClick(() => { this.onSubmit(''); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}
