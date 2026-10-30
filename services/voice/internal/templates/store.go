package templates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MemoryStore is an in-process TemplateStore. It is seeded from the
// embedded library on construction (see seed.go).
type MemoryStore struct {
	mu      sync.RWMutex
	byID    map[string]Template
	bySlug  map[string]string // slug → id
	ordered []string          // insertion order for stable List
}

// NewMemoryStore returns an empty store. Callers normally use Seeded()
// instead, which preloads the embedded library.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		byID:   map[string]Template{},
		bySlug: map[string]string{},
	}
}

// put is the unsynchronized insert helper used by both Seed and Create.
func (m *MemoryStore) put(t Template) Template {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	if t.CreatedAt.IsZero() {
		t.CreatedAt = time.Now().UTC()
	}
	t.UpdatedAt = time.Now().UTC()
	if _, exists := m.byID[t.ID]; !exists {
		m.ordered = append(m.ordered, t.ID)
	}
	m.byID[t.ID] = t
	if t.Slug != "" {
		m.bySlug[t.Slug] = t.ID
	}
	return t
}

// Get implements TemplateStore. Accepts either a UUID id or a slug.
func (m *MemoryStore) Get(_ context.Context, idOrSlug string) (Template, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if t, ok := m.byID[idOrSlug]; ok {
		return t, nil
	}
	if id, ok := m.bySlug[idOrSlug]; ok {
		return m.byID[id], nil
	}
	return Template{}, ErrNotFound
}

// List implements TemplateStore. An empty category returns all templates.
func (m *MemoryStore) List(_ context.Context, category TemplateCategory) ([]Template, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Template, 0, len(m.ordered))
	for _, id := range m.ordered {
		t := m.byID[id]
		if category != "" && t.Category != category {
			continue
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return out[i].Slug < out[j].Slug
	})
	return out, nil
}

// Create implements TemplateStore.
func (m *MemoryStore) Create(_ context.Context, t Template) (Template, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if strings.TrimSpace(t.Slug) == "" {
		return Template{}, fmt.Errorf("templates: slug required")
	}
	if _, ok := m.bySlug[t.Slug]; ok {
		return Template{}, ErrConflict
	}
	return m.put(t), nil
}

// Update implements TemplateStore.
func (m *MemoryStore) Update(_ context.Context, t Template) (Template, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.byID[t.ID]; !ok {
		return Template{}, ErrNotFound
	}
	for slug, id := range m.bySlug {
		if slug == t.Slug && id != t.ID {
			return Template{}, ErrConflict
		}
		if id == t.ID && slug != t.Slug {
			delete(m.bySlug, slug)
		}
	}
	return m.put(t), nil
}

// Delete implements TemplateStore.
func (m *MemoryStore) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.byID[id]
	if !ok {
		return ErrNotFound
	}
	delete(m.byID, id)
	delete(m.bySlug, t.Slug)
	for i, oid := range m.ordered {
		if oid == id {
			m.ordered = append(m.ordered[:i], m.ordered[i+1:]...)
			break
		}
	}
	return nil
}

// PostgresStore persists shared/admin-authored templates in voice_templates.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// NewPostgresStore constructs a Postgres template store.
func NewPostgresStore(pool *pgxpool.Pool) (*PostgresStore, error) {
	if pool == nil {
		return nil, errors.New("templates: nil pgx pool")
	}
	return &PostgresStore{Pool: pool}, nil
}

// Get implements TemplateStore. Accepts either id or slug.
func (s *PostgresStore) Get(ctx context.Context, idOrSlug string) (Template, error) {
	row := s.Pool.QueryRow(ctx, `
		SELECT id::text, slug, category, name, COALESCE(description, ''),
		       length, variables, emails, COALESCE(tags, ARRAY[]::text[]),
		       COALESCE(author, ''), COALESCE(performance, '{}'::jsonb),
		       created_at, updated_at
		  FROM voice_templates
		 WHERE id::text = $1 OR slug = $1
	`, idOrSlug)
	t, err := scanTemplate(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, ErrNotFound
	}
	return t, err
}

// List implements TemplateStore.
func (s *PostgresStore) List(ctx context.Context, category TemplateCategory) ([]Template, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text, slug, category, name, COALESCE(description, ''),
		       length, variables, emails, COALESCE(tags, ARRAY[]::text[]),
		       COALESCE(author, ''), COALESCE(performance, '{}'::jsonb),
		       created_at, updated_at
		  FROM voice_templates
		 WHERE ($1 = '' OR category = $1)
		 ORDER BY category, slug
	`, string(category))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Create implements TemplateStore.
func (s *PostgresStore) Create(ctx context.Context, t Template) (Template, error) {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	if t.Length == 0 {
		t.Length = len(t.Emails)
	}
	variables, emails, performance, err := marshalTemplateJSON(t)
	if err != nil {
		return Template{}, err
	}
	row := s.Pool.QueryRow(ctx, `
		INSERT INTO voice_templates
			(id, slug, category, name, description, length, variables, emails, tags, author, performance)
		VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6, $7::jsonb, $8::jsonb, $9, NULLIF($10, ''), $11::jsonb)
		ON CONFLICT (slug) DO NOTHING
		RETURNING id::text, slug, category, name, COALESCE(description, ''),
		          length, variables, emails, COALESCE(tags, ARRAY[]::text[]),
		          COALESCE(author, ''), COALESCE(performance, '{}'::jsonb),
		          created_at, updated_at
	`, t.ID, t.Slug, string(t.Category), t.Name, t.Description, t.Length,
		string(variables), string(emails), t.Tags, t.Author, string(performance))
	created, err := scanTemplate(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, ErrConflict
	}
	return created, err
}

// Update implements TemplateStore.
func (s *PostgresStore) Update(ctx context.Context, t Template) (Template, error) {
	if t.Length == 0 {
		t.Length = len(t.Emails)
	}
	variables, emails, performance, err := marshalTemplateJSON(t)
	if err != nil {
		return Template{}, err
	}
	row := s.Pool.QueryRow(ctx, `
		UPDATE voice_templates
		   SET slug = $2,
		       category = $3,
		       name = $4,
		       description = NULLIF($5, ''),
		       length = $6,
		       variables = $7::jsonb,
		       emails = $8::jsonb,
		       tags = $9,
		       author = NULLIF($10, ''),
		       performance = $11::jsonb,
		       updated_at = now()
		 WHERE id = $1::uuid
		RETURNING id::text, slug, category, name, COALESCE(description, ''),
		          length, variables, emails, COALESCE(tags, ARRAY[]::text[]),
		          COALESCE(author, ''), COALESCE(performance, '{}'::jsonb),
		          created_at, updated_at
	`, t.ID, t.Slug, string(t.Category), t.Name, t.Description, t.Length,
		string(variables), string(emails), t.Tags, t.Author, string(performance))
	updated, err := scanTemplate(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, ErrNotFound
	}
	return updated, err
}

// Delete implements TemplateStore.
func (s *PostgresStore) Delete(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM voice_templates WHERE id::text = $1 OR slug = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type templateScanner interface {
	Scan(dest ...any) error
}

func scanTemplate(row templateScanner) (Template, error) {
	var t Template
	var category string
	var variables, emails, performance []byte
	if err := row.Scan(&t.ID, &t.Slug, &category, &t.Name, &t.Description,
		&t.Length, &variables, &emails, &t.Tags, &t.Author, &performance,
		&t.CreatedAt, &t.UpdatedAt); err != nil {
		return Template{}, err
	}
	t.Category = TemplateCategory(category)
	if err := json.Unmarshal(variables, &t.Variables); err != nil {
		return Template{}, fmt.Errorf("templates: decode variables: %w", err)
	}
	if err := json.Unmarshal(emails, &t.Emails); err != nil {
		return Template{}, fmt.Errorf("templates: decode emails: %w", err)
	}
	if len(performance) > 0 {
		if err := json.Unmarshal(performance, &t.Performance); err != nil {
			return Template{}, fmt.Errorf("templates: decode performance: %w", err)
		}
	}
	return t, nil
}

func marshalTemplateJSON(t Template) (variables, emails, performance []byte, err error) {
	variables, err = json.Marshal(t.Variables)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("templates: encode variables: %w", err)
	}
	emails, err = json.Marshal(t.Emails)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("templates: encode emails: %w", err)
	}
	performance, err = json.Marshal(t.Performance)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("templates: encode performance: %w", err)
	}
	return variables, emails, performance, nil
}

var _ TemplateStore = (*PostgresStore)(nil)
