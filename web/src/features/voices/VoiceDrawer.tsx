import { Tabs } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconMicrophone2 } from '@tabler/icons-react';
import { useSession, type VoiceTab } from '../../store/session';
import { useSettings } from '../../store/settings';
import { ResponsiveDrawer } from '../../ui/ResponsiveDrawer';
import { BlendEditor } from './BlendEditor';
import { VoicePicker } from './VoicePicker';

/** Voice drawer: pick a voice (search, filters, previews, favourites) or build a blend. */
export default function VoiceDrawer({ onRetryVoices }: { onRetryVoices: () => void }) {
  const opened = useSession((s) => s.drawer === 'voices');
  const close = useSession((s) => s.closeDrawer);
  const tab = useSession((s) => s.voiceTab);
  const setTab = useSession((s) => s.setVoiceTab);
  const voice = useSettings((s) => s.voice);

  return (
    <ResponsiveDrawer opened={opened} onClose={close} title="Voice">
      <Tabs value={tab} onChange={(v) => setTab((v as VoiceTab) ?? 'voices')} keepMounted={false}>
        <Tabs.List grow mb="md">
          <Tabs.Tab value="voices" leftSection={<IconMicrophone2 size={16} />}>
            Voices
          </Tabs.Tab>
          <Tabs.Tab value="blend" leftSection={<IconAdjustmentsHorizontal size={16} />}>
            Blend
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="voices">
          <VoicePicker onRetry={onRetryVoices} />
        </Tabs.Panel>
        <Tabs.Panel value="blend">
          <BlendEditor key={voice} />
        </Tabs.Panel>
      </Tabs>
    </ResponsiveDrawer>
  );
}
