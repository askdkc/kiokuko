import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor, type Key } from 'node:readline';
import { KiokukoError } from '../errors.js';

export type TerminalInput = NodeJS.ReadableStream & {
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode(mode: boolean): unknown;
};

export function supportsKeyboardSelection(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): input is TerminalInput {
  return (input as { isTTY?: boolean }).isTTY === true
    && (output as { isTTY?: boolean }).isTTY === true
    && typeof (input as Partial<TerminalInput>).setRawMode === 'function';
}

export interface CheckboxChoice<T extends string> { value: T; label: string }

/** Resolve a keyboard selection before the caller starts any destructive work. */
export async function promptCheckboxes<T extends string>(
  input: TerminalInput,
  output: NodeJS.WritableStream,
  choices: readonly CheckboxChoice<T>[],
  options: { selected: readonly T[]; heading: string; cancelMessage: string },
): Promise<T[]> {
  if (choices.length === 0) return [];
  const checked = new Set(options.selected);
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const terminal = output as NodeJS.WritableStream & { columns?: number; rows?: number };
  let focused = 0;
  let renderedRows = 0;
  let settled = false;
  let onKeypress: (value: string | undefined, key: Key) => void;
  let onFailure: (error: Error) => void;
  let onCancel: () => void;
  let onResize: () => void;

  const render = () => {
    if (renderedRows > 0) moveCursor(output, 0, -renderedRows);
    cursorTo(output, 0);
    clearScreenDown(output);
    const count = Math.min(choices.length, Math.max(1, (terminal.rows || 24) - 1));
    const start = Math.max(0, focused - count + 1);
    const rows = choices.slice(start, start + count).map((choice, offset) => {
      const index = start + offset;
      const row = `${index === focused ? '>' : ' '} ${index + 1}. [${checked.has(choice.value) ? 'x' : ' '}] ${choice.label}`;
      return row.slice(0, Math.max(1, (terminal.columns || 80) - 1));
    });
    output.write(`${rows.join('\n')}\n`);
    renderedRows = rows.length;
  };

  try {
    return await new Promise<T[]>((resolve, reject) => {
      onFailure = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      onCancel = () => onFailure(new KiokukoError('USAGE_ERROR', options.cancelMessage));
      onResize = () => {
        if (settled) return;
        try { render(); } catch (error) { onFailure(error as Error); }
      };
      onKeypress = (_value, key) => {
        if (settled) return;
        if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
          onCancel();
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          settled = true;
          resolve(choices.filter((choice) => checked.has(choice.value)).map((choice) => choice.value));
          return;
        }
        if (key.ctrl || key.meta) return;
        if (key.name === 'up' || key.name === 'down') {
          focused = (focused + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
        } else {
          const number = Number(key.sequence);
          if (Number.isInteger(number) && number >= 1 && number <= choices.length) {
            focused = number - 1;
          } else if (key.name !== 'space') {
            return;
          }
          const client = choices[focused]!.value;
          if (checked.has(client)) checked.delete(client);
          else checked.add(client);
        }
        onResize();
      };
      input.on('keypress', onKeypress);
      input.once('end', onCancel);
      input.once('close', onCancel);
      input.once('error', onFailure);
      output.once('error', onFailure);
      output.on('resize', onResize);
      emitKeypressEvents(input);
      input.setRawMode(true);
      output.write(`${options.heading}\n`);
      output.write(`Up/Down: move | Space: toggle | 1-${choices.length}: toggle\n`);
      output.write('Enter: confirm | Esc/Ctrl+C: cancel\n');
      render();
      input.resume();
    });
  } finally {
    input.removeListener('keypress', onKeypress!);
    input.removeListener('end', onCancel!);
    input.removeListener('close', onCancel!);
    input.removeListener('error', onFailure!);
    output.removeListener('error', onFailure!);
    output.removeListener('resize', onResize!);
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}
