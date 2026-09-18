import { useCallback, useEffect, useState } from 'react';
import { useAppStore, EMPTY_COMPOSER_DRAFT } from '../store';
import type { DraftAttachedFile, DraftPastedImage } from '../types';

/**
 * Composer draft bound to a context key ('welcome' for the welcome screen,
 * sessionId for each chat). The draft lives in the global store, so it
 * survives component unmounts (e.g. switching to Settings) and, for chats,
 * switching between sessions — each context keeps its own draft.
 *
 * The hook owns the local state and mirrors every change into the store.
 * When `key` changes while the component stays mounted (session switch
 * inside ChatView), state is reset during render from the store — this is
 * React's officially supported "adjust state on prop change" pattern, and
 * it runs before the sync effect, so the previous key's draft (already
 * saved on its last keystroke) is never clobbered.
 */
export function useComposerDraft(key: string) {
  const setDraft = useAppStore((s) => s.setDraft);
  const clearDraft = useAppStore((s) => s.clearDraft);

  const [prompt, setPrompt] = useState(() => (useAppStore.getState().drafts[key] ?? EMPTY_COMPOSER_DRAFT).prompt);
  const [pastedImages, setPastedImages] = useState<DraftPastedImage[]>(
    () => (useAppStore.getState().drafts[key] ?? EMPTY_COMPOSER_DRAFT).pastedImages
  );
  const [attachedFiles, setAttachedFiles] = useState<DraftAttachedFile[]>(
    () => (useAppStore.getState().drafts[key] ?? EMPTY_COMPOSER_DRAFT).attachedFiles
  );

  // Reset local state when the draft key changes (same component instance).
  const [draftKey, setDraftKey] = useState(key);
  if (draftKey !== key) {
    setDraftKey(key);
    const d = useAppStore.getState().drafts[key] ?? EMPTY_COMPOSER_DRAFT;
    setPrompt(d.prompt);
    setPastedImages(d.pastedImages);
    setAttachedFiles(d.attachedFiles);
  }

  // Mirror local state into the global store on every change.
  useEffect(() => {
    setDraft(key, { prompt, pastedImages, attachedFiles });
  }, [key, prompt, pastedImages, attachedFiles, setDraft]);

  /** Clears both local state and the stored draft. Callers should revoke
   *  any image object URLs themselves before calling this. */
  const clearComposerDraft = useCallback(() => {
    setPrompt('');
    setPastedImages([]);
    setAttachedFiles([]);
    clearDraft(key);
  }, [clearDraft, key]);

  return {
    prompt,
    setPrompt,
    pastedImages,
    setPastedImages,
    attachedFiles,
    setAttachedFiles,
    clearComposerDraft,
  };
}
