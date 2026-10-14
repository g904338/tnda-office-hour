import { kindStyle, type Config, type Post } from '../core/model';
import { labelOf, postTime } from '../core/ops';
import { fmtDate, fmtTime } from '../core/time';
import { ChannelChips, Rel, StatusChip } from '../ui/parts';
import { openPost } from './PostDetail';

export function PostRow({ post, config, date }: { post: Post; config: Config; date?: boolean }) {
  const k = kindStyle(config, post.content.kind);
  const tz = config.timezone;
  const at = postTime(post);
  const label = post.status === 'scheduled' || post.status === 'sending' || post.status === 'draft' ? labelOf(post) : null;
  return (
    <button type="button" class={`post-row st-${post.status}`} onClick={() => openPost(post.id)}>
      <span class="pr-time">
        {at !== null ? (
          <>
            {date && <span class="pr-date">{fmtDate(at, tz)}</span>}
            <b class="mono">{fmtTime(at, tz)}</b>
            <span class="pr-rel">
              <Rel ms={at} tz={tz} />
            </span>
          </>
        ) : (
          <span class="pr-rel">草稿</span>
        )}
      </span>
      <span class="pr-bar" style={{ '--k': k.color } as any} aria-hidden="true" />
      <span class="pr-main">
        <span class="pr-title">
          <span aria-hidden="true">{k.emoji}</span> {post.content.title || k.headline}
        </span>
        <span class="pr-sub">
          {label && <span class="pr-label">{label}</span>}
          {post.series && (
            <span class="pr-series" title="同一則公告的第幾次發送">
              {post.series.index}/{post.series.total}
            </span>
          )}
          <ChannelChips post={post} config={config} deliveries={post.status !== 'scheduled' && post.status !== 'draft'} />
        </span>
      </span>
      <span class="pr-status">
        <StatusChip status={post.status} small />
      </span>
    </button>
  );
}
