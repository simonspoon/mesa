import { useState } from 'react'
import { deletePost, getPost, replyToPost, updatePost } from '../api'
import { getAuthor, setAuthor } from '../author'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { InlineEdit } from '../components/InlineEdit'
import { Markdown } from '../components/Markdown'
import type { Post } from '../types/Post'
import { useFetch } from '../useFetch'

/** Author/timestamp line for a post or reply. */
function PostMeta({ post }: { post: Post }) {
  return (
    <div className="muted storyboard-meta">
      {post.author && <span>by {post.author} · </span>}
      <span>posted {post.created_at}</span>
      {post.updated_at !== post.created_at && (
        <span> · edited {post.updated_at}</span>
      )}
    </div>
  )
}

/** A reply: meta + markdown body, read-only. */
function ReplyBody({ post }: { post: Post }) {
  return (
    <div className="post-body">
      <PostMeta post={post} />
      <Markdown text={post.body} />
    </div>
  )
}

/**
 * The root post's body: rendered as markdown, with an inline "edit" toggle that
 * swaps to a textarea (so the body shows once — as formatted text — not twice).
 */
function EditableBody({
  post,
  onSaved,
}: {
  post: Post
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(post.body)
  const [error, setError] = useState<string | null>(null)

  function save(e: React.FormEvent) {
    e.preventDefault()
    updatePost(post.id, { body: draft }).then(
      () => {
        setEditing(false)
        setError(null)
        onSaved()
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
  }

  if (editing) {
    return (
      <form className="post-edit" onSubmit={save}>
        <textarea
          value={draft}
          rows={4}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="post-edit-actions">
          <button type="submit">save</button>
          <button
            type="button"
            onClick={() => {
              setDraft(post.body)
              setEditing(false)
              setError(null)
            }}
          >
            cancel
          </button>
        </div>
        {error && <span className="error">{error}</span>}
      </form>
    )
  }

  return (
    <div className="post-body">
      <Markdown text={post.body} />
      <button
        type="button"
        className="post-edit-toggle"
        onClick={() => {
          setDraft(post.body)
          setEditing(true)
        }}
      >
        edit
      </button>
    </div>
  )
}

/**
 * A single bulletin thread: the post (title/body editable, deletable) and its
 * replies, with a form to add one. Rendered in place inside ProjectTasksPage's
 * frame. URL-driven via `postId` (refresh-/back-stable); deleting returns to
 * the board index. Live-syncs so replies from agents/the CLI appear.
 */
export function BulletinThreadView({
  projectId,
  postId,
}: {
  projectId: number
  postId: number
}) {
  const { data: thread, error, refetch } = useFetch(
    () => getPost(postId),
    `post-${postId}`,
    { pollMs: 3000 },
  )

  const [reply, setReply] = useState('')
  const [author, setAuthorState] = useState(getAuthor())
  const [replyError, setReplyError] = useState<string | null>(null)

  function submitReply(e: React.FormEvent) {
    e.preventDefault()
    setAuthor(author)
    replyToPost(postId, { body: reply, author }).then(
      () => {
        setReply('')
        setReplyError(null)
        refetch()
      },
      (err: unknown) =>
        setReplyError(err instanceof Error ? err.message : String(err)),
    )
  }

  if (error) return <p className="error">{error}</p>
  if (!thread) return <p className="muted">Loading…</p>

  const { post, replies } = thread

  return (
    <div className="bulletin-thread">
      <p>
        <a href={`#/projects/${projectId}/posts`}>← all posts</a>
      </p>

      <h2 className="post-title">
        <InlineEdit
          value={post.title ?? ''}
          placeholder="(untitled) — click to add a title"
          onSave={(title) =>
            updatePost(post.id, { title: title === '' ? null : title }).then(
              refetch,
            )
          }
        />
      </h2>
      {post.tag && <span className="post-tag">{post.tag}</span>}

      <PostMeta post={post} />
      <EditableBody post={post} onSaved={refetch} />

      <h3 className="replies-heading">
        {replies.length === 0
          ? 'No replies yet'
          : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
      </h3>
      {replies.length > 0 && (
        <ul className="reply-list">
          {replies.map((r) => (
            <li key={r.id}>
              <ReplyBody post={r} />
            </li>
          ))}
        </ul>
      )}

      <form className="create-form post-reply" onSubmit={submitReply}>
        <textarea
          value={reply}
          placeholder="write a reply…"
          required
          rows={2}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="post-create-meta">
          <input
            type="text"
            value={author}
            placeholder="you"
            title="your name — stamped on what you post"
            onChange={(e) => setAuthorState(e.target.value)}
          />
          <button type="submit">reply</button>
        </div>
        {replyError && <span className="error">{replyError}</span>}
      </form>

      <p className="project-danger">
        <ConfirmDelete
          label="delete post"
          message={`Deletes this post and ${replies.length} ${
            replies.length === 1 ? 'reply' : 'replies'
          }.`}
          onDelete={() =>
            deletePost(post.id).then(() => {
              window.location.hash = `#/projects/${projectId}/posts`
            })
          }
        />
      </p>
    </div>
  )
}
