/**
 * カメラ選択メニュー。
 *
 * ボタンには**省略名**（背トリプル）を出し、開いたリストには**フルネーム**
 * （背面トリプルカメラ）を出す。ネイティブの `<select>` は閉じているときも
 * 選択肢の文字をそのまま出すので、この出し分けができない。操作バーは映像に
 * 重ねる場所で幅が限られるため、自前の小さなメニューにする。
 */

export interface CameraChoice {
  readonly deviceId: string;
  /** リストに出す名前。 */
  readonly label: string;
  /** ボタンに出す短い名前。 */
  readonly short: string;
}

export interface CameraMenuHandle {
  /** 選択肢を差し替える。空なら丸ごと隠す（カメラが 1 台だけなら選ぶ意味がない）。 */
  setChoices(choices: readonly CameraChoice[], selectedId: string | null): void;
  clear(): void;
}

export function createCameraMenu(
  container: HTMLElement,
  onSelect: (deviceId: string) => void,
): CameraMenuHandle {
  container.replaceChildren();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'camera-menu-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');

  const list = document.createElement('div');
  list.className = 'camera-menu-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  container.append(button, list);

  const setOpen = (open: boolean): void => {
    list.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(list.hidden === true);
  });

  // 外側をタップ / Escape で閉じる（開きっぱなしで映像を隠さない）
  document.addEventListener('click', () => {
    setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  return {
    setChoices(choices, selectedId): void {
      container.hidden = choices.length < 2;
      setOpen(false);
      list.replaceChildren();

      const selected = choices.find((choice) => choice.deviceId === selectedId) ?? choices[0];
      if (selected === undefined) return;
      button.textContent = selected.short;

      for (const choice of choices) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'camera-menu-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(choice.deviceId === selected.deviceId));
        option.textContent = choice.label;
        option.addEventListener('click', (event) => {
          event.stopPropagation();
          setOpen(false);
          button.textContent = choice.short;
          onSelect(choice.deviceId);
        });
        list.append(option);
      }
    },
    clear(): void {
      setOpen(false);
      list.replaceChildren();
      container.hidden = true;
    },
  };
}
