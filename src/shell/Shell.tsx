import { Switch, Match } from 'solid-js';
import LeftRail from './LeftRail';
import Header from './Header';
import { room } from '~/state/room';
import BlockHost from './BlockHost';

export default function Shell() {
  return (
    <div class="h-screen flex flex-col">
      <Header />
      <div class="flex flex-1 min-h-0">
        <LeftRail />
        <main class="flex-1 overflow-auto p-4">
          <Switch>
            <Match when={room() === 'add'}>
              <BlockHost id="room-add" />
            </Match>
            <Match when={room() === 'libraries'}>
              <BlockHost id="room-libraries-stub" />
            </Match>
            <Match when={room() === 'settings'}>
              <BlockHost id="room-settings" />
            </Match>
          </Switch>
        </main>
      </div>
    </div>
  );
}
