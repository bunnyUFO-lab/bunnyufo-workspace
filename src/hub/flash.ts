// A one-line note handed to the next screen: "Marked done" after a review is cleared from its own view.
let note = ''
export const setFlash = (text: string) => { note = text }
export const takeFlash = () => { const text = note; note = ''; return text }
