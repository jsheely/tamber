import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useHealth } from './api/useHealth';
import { useVoices } from './api/useVoices';
import { Composer } from './features/compose/Composer';
import { ReaderPanel } from './features/compose/ReaderPanel';
import { SidePanel } from './features/compose/SidePanel';
import { Drawers } from './features/Drawers';
import { usePlayerBindings, usePlayerHotkeys } from './player/usePlayerBindings';
import { usePlayerState } from './player/usePlayer';
import { useSession } from './store/session';
import { Header } from './ui/Header';
import { PlayerDock } from './ui/PlayerDock';
import { TapToResume } from './ui/TapToResume';
import { UpdateBanner } from './ui/UpdateBanner';
import classes from './App.module.css';

export function App() {
  const refreshHealth = useHealth();
  useVoices();
  usePlayerBindings();
  usePlayerHotkeys();
  const view = useSession((s) => s.view);
  const hasSession = usePlayerState((s) => s.hasSession);
  const reading = view === 'read' && hasSession;

  return (
    <div className={classes.app}>
      <Header />
      <UpdateBanner />
      <div className={classes.scroller} data-app-scroller>
        <main className={classes.main}>
        <div className={classes.primary}>
          <LayoutGroup>
            <AnimatePresence mode="popLayout" initial={false}>
              {reading ? (
                <motion.div
                  key="reader"
                  className={classes.view}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <ReaderPanel />
                </motion.div>
              ) : (
                <motion.div
                  key="compose"
                  className={classes.view}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Composer />
                </motion.div>
              )}
            </AnimatePresence>
          </LayoutGroup>
        </div>
          <aside className={classes.side} aria-label="Voice and playback">
            <SidePanel />
          </aside>
        </main>
      </div>
      <PlayerDock />
      <TapToResume />
      <Drawers onRetryVoices={refreshHealth} />
    </div>
  );
}
