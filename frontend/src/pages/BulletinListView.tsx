import { useState } from 'react'
import { createPost, listPosts } from '../api'
import { getAuthor, setAuthor } from '../author'
import { useFetch } from '../useFetch'

/**
 * The project bulletin board: an open feed of findings, lessons, news, and
 * questions agents (and people) post. This is the index — top-level posts,
 * newest first, with a compact create form; a post's body and its replies live
 * in BulletinThreadView. Rendered in place inside ProjectTasksPage's frame, so
 * it carries no header of its own. Filters are URL-free local state; the list
 * live-syncs (agents write the DB underneath us).
 */
export function BulletinListView({ projectId }: { projectId: number }) {
  const [tag, setTag] = useState('')
  const [byAuthor, setByAuthor] = useState('')
  const { data: posts, error, refetch } = useFetch(
    () =>
      listPosts({
        project: projectId,
        tag: tag === '' ? undefined : tag,
        author: byAuthor === '' ? undefined : byAuthor,
      }),
    `posts-${projectId}-${tag}-${byAuthor}`,
    { pollMs: 3000 },
  )

  const [body, setBody] = useState('')
  const [title, setTitle] = useState('')
  const [newTag, setNewTag] = useState('')
  const [author, setAuthorState] = useState(getAuthor())
  const [createError, setCreateError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setAuthor(author)
    createPost({
      project_id: projectId,
      body,
      title: title === '' ? undefined : title,
      tag: newTag === '' ? undefined : newTag,
      author,
    }).then(
      (post) => {
        setBody('')
        setTitle('')
        setNewTag('')
        setCreateError(null)
        refetch()
        window.location.hash = `#/projects/${projectId}/posts/${post.id}`
      },
      (err: unknown) =>
        setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  return (
    <>
      <form className="create-form post-create" onSubmit={submit}>
        <textarea
          value={body}
          placeholder="share a finding, lesson, news, or question…"
          required
          rows={3}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="post-create-meta">
          <input
            type="text"
            value={title}
            placeholder="title (optional)"
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="text"
            value={newTag}
            placeholder="tag (optional)"
            title="your own category, e.g. finding / question / news"
            onChange={(e) => setNewTag(e.target.value)}
          />
          <input
            type="text"
            value={author}
            placeholder="you"
            title="your name — stamped on what you post"
            onChange={(e) => setAuthorState(e.target.value)}
          />
          <button type="submit">post</button>
        </div>
        {createError && <span className="error">{createError}</span>}
      </form>

      <div className="filters">
        <label>
          Tag{' '}
          <input
            type="text"
            value={tag}
            placeholder="filter by tag"
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
        <label>
          Author{' '}
          <input
            type="text"
            value={byAuthor}
            placeholder="filter by author"
            onChange={(e) => setByAuthor(e.target.value)}
          />
        </label>
      </div>

      {error ? (
        <p className="error">{error}</p>
      ) : !posts ? (
        <p className="muted">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="muted">No posts yet.</p>
      ) : (
        <ul className="card-list">
          {posts.map((p) => (
            <li key={p.id}>
              <a href={`#/projects/${projectId}/posts/${p.id}`}>
                {p.title || '(untitled post)'}
              </a>
              {p.tag && <span className="post-tag">{p.tag}</span>}
              {p.reply_count > 0 && (
                <span className="muted">
                  {' '}
                  · {p.reply_count}{' '}
                  {p.reply_count === 1 ? 'reply' : 'replies'}
                </span>
              )}
              <div className="muted storyboard-meta">
                {p.author && <span>by {p.author} · </span>}
                <span>posted {p.created_at}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
