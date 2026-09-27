import { useSession } from '../../store/session';
import { ResponsiveDrawer } from '../../ui/ResponsiveDrawer';
import { SidePanel } from './SidePanel';

/**
 * Phones: the desktop side column (orb, voice, quick playback settings, recent texts) as a
 * bottom sheet, opened from the voice button in the header. Keeps the main screen for the text.
 */
export default function PanelDrawer() {
  const opened = useSession((s) => s.drawer === 'panel');
  const close = useSession((s) => s.closeDrawer);
  return (
    <ResponsiveDrawer opened={opened} onClose={close} title="Voice and playback">
      <SidePanel />
    </ResponsiveDrawer>
  );
}
