/**
 * Library: the last 20 documents. Tap to read again (re-synthesises), swipe left to delete.
 */
import { router } from 'expo-router';
import { useCallback } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';

import { formatDuration } from '@/content/extract';
import { openContent } from '@/player/controller';
import { useLibrary, type LibraryItem } from '@/store/library';
import { radius, spacing, type, usePalette, useReduceMotion } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Button, Screen, ScreenHeader } from '@/ui/primitives';

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function Row({ item, onDelete }: { item: LibraryItem; onDelete: (id: string) => void }) {
  const p = usePalette();
  const reduce = useReduceMotion();
  return (
    <Animated.View exiting={reduce ? undefined : FadeOut.duration(180)} layout={reduce ? undefined : LinearTransition}>
      <ReanimatedSwipeable
        friction={2}
        rightThreshold={60}
        overshootRight={false}
        onSwipeableOpen={(direction) => {
          if (direction === 'left') onDelete(item.id);
        }}
        renderRightActions={() => (
          <View style={[styles.deleteAction, { backgroundColor: p.danger }]}>
            <Icon name="trash" color="#FFFFFF" size={22} />
            <Text style={[type.small, { color: '#FFFFFF', fontWeight: '700' }]}>Delete</Text>
          </View>
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Read ${item.title} again`}
          accessibilityActions={[{ name: 'delete', label: 'Delete' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'delete') onDelete(item.id);
          }}
          onPress={() => {
            router.push('/player');
            void openContent({ kind: 'library', id: item.id }, { autoStart: true });
          }}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? p.surfaceAlt : p.surface, borderColor: p.border },
          ]}
        >
          <View style={[styles.iconWrap, { backgroundColor: p.surfaceAlt }]}>
            <Icon
              name={item.kind === 'url' ? 'link' : item.kind === 'file' ? 'file' : item.kind === 'share' ? 'share' : 'type'}
              color={p.link}
              size={20}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.body, { color: p.text, fontWeight: '600' }]} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={[type.small, { color: p.textFaint }]} numberOfLines={1}>
              {item.source ? `${item.source} · ` : ''}
              {relativeTime(item.createdAt)} · ~{formatDuration(item.charCount / 5.5 / 160)}
            </Text>
          </View>
          <Icon name="play" color={p.textDim} size={18} />
        </Pressable>
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

export default function LibraryScreen() {
  const p = usePalette();
  const items = useLibrary((s) => s.items);
  const remove = useLibrary((s) => s.remove);
  const clear = useLibrary((s) => s.clear);
  const onDelete = useCallback((id: string) => remove(id), [remove]);

  return (
    <Screen>
      <ScreenHeader
        title="Library"
        right={
          items.length > 0 ? (
            <Button
              label="Clear"
              icon="trash"
              compact
              onPress={() =>
                Alert.alert('Clear the library?', 'All saved documents are removed from this device.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: clear },
                ])
              }
            />
          ) : null
        }
      />
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => <Row item={item} onDelete={onDelete} />}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="history" color={p.textFaint} size={40} />
            <Text style={[type.body, { color: p.textDim, textAlign: 'center' }]}>
              Things you read appear here. The last 20 are kept on this device.
            </Text>
          </View>
        }
        ListFooterComponent={
          items.length > 0 ? (
            <Text style={[type.small, { color: p.textFaint, textAlign: 'center', marginTop: spacing.md }]}>
              Swipe left to delete.
            </Text>
          ) : null
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  deleteAction: {
    width: 96,
    marginLeft: spacing.sm,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
});
