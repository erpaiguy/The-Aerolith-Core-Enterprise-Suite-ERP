// The keyboard shortcuts the app really has (docs/wave9-plan.md step 9b.2), for the Help centre. Each comes from the
// code that handles it: the search palette, the help key, dialogs, tabs and data grids in @aerolith/ui, the BOQ grid
// and the programme editor. Change this list when a handler changes.

export interface Shortcut {
  keys: string[];
  does: string;
}
export interface ShortcutGroup {
  where: string;
  shortcuts: Shortcut[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    where: 'Anywhere',
    shortcuts: [
      {
        keys: ['Ctrl+K'],
        does: 'Search everything: screens, projects, tenders, parties and numbers (⌘K on a Mac).',
      },
      { keys: ['?', 'F1'], does: 'Help for this page (not while typing in a field).' },
      { keys: ['Esc'], does: 'Close a dialog, a menu or the help panel.' },
      { keys: ['Tab', 'Shift+Tab'], does: 'Move to the next or previous button, link or field.' },
      { keys: ['Enter'], does: 'Press the button or open the link that has the focus.' },
    ],
  },
  {
    where: 'Search and help lists',
    shortcuts: [
      { keys: ['↓', '↑'], does: 'Move through the results.' },
      { keys: ['Enter'], does: 'Open the highlighted result.' },
    ],
  },
  {
    where: 'Tabs',
    shortcuts: [
      { keys: ['←', '→'], does: 'Move to the previous or next tab.' },
      { keys: ['Home', 'End'], does: 'Jump to the first or last tab.' },
    ],
  },
  {
    where: 'Lists (data grids)',
    shortcuts: [
      {
        keys: ['Enter', 'Space'],
        does: 'On a column heading: sort by it; again for the other way; a third time to stop sorting.',
      },
      { keys: ['←', '→'], does: 'On a column’s edge: make it narrower or wider.' },
      { keys: ['Shift+←', 'Shift+→'], does: 'On a column’s edge: in bigger steps.' },
      { keys: ['Esc'], does: 'Close the column chooser.' },
    ],
  },
  {
    where: 'BOQ',
    shortcuts: [
      { keys: ['↑', '↓', '←', '→'], does: 'Move between cells.' },
      { keys: ['Page Up', 'Page Down'], does: 'Move a screen up or down.' },
      { keys: ['Ctrl+Home', 'Ctrl+End'], does: 'Go to the first or last row.' },
      { keys: ['Enter', 'F2'], does: 'Edit the cell; or just start typing.' },
      { keys: ['Enter', 'Shift+Enter'], does: 'While editing: save and move down or up.' },
      { keys: ['Tab', 'Shift+Tab'], does: 'Move right or left; while editing, save first.' },
      { keys: ['Esc'], does: 'Cancel the edit, or clear the selection.' },
      { keys: ['Delete', 'Backspace'], does: 'Clear the cell.' },
      { keys: ['Ctrl+Enter'], does: 'Insert an item.' },
      { keys: ['Ctrl+Shift+Enter'], does: 'Insert a section.' },
      { keys: ['Ctrl+Delete'], does: 'Delete the row (asks first).' },
      { keys: ['Ctrl+Z'], does: 'Undo.' },
      { keys: ['Alt+Shift+→', 'Alt+Shift+←'], does: 'Indent or outdent the row.' },
      { keys: ['Alt+Shift+↑', 'Alt+Shift+↓'], does: 'Move the row up or down.' },
      { keys: ['Space'], does: 'On a section’s description: fold or unfold it.' },
    ],
  },
  {
    where: 'Programme and schedules',
    shortcuts: [
      { keys: ['↑', '↓'], does: 'Select the activity above or below.' },
      { keys: ['Insert'], does: 'Add an activity.' },
      { keys: ['Delete'], does: 'Delete the selected activity.' },
      { keys: ['Alt+Shift+→', 'Alt+Shift+←'], does: 'Indent or outdent the activity.' },
      { keys: ['Enter', 'F2'], does: 'Edit a cell; Enter again saves, Esc cancels.' },
    ],
  },
];
