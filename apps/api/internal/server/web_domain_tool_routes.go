// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/custom_domains"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dmarc"
	"github.com/postwave/postwave/apps/api/internal/email_template"
	"github.com/postwave/postwave/apps/api/internal/link_checker"
)

type WebDomainToolRouteDeps struct {
	Router chi.Router
	Pool   *db.Pool
	Logger *slog.Logger
}

type WebDomainToolSurface struct {
	DMARC         *dmarc.Deps
	EmailTemplate *email_template.Deps
	CustomDomains *custom_domains.Deps
	LinkChecker   *link_checker.Deps
}

func MountWebDomainToolRoutes(deps WebDomainToolRouteDeps) WebDomainToolSurface {
	if deps.Router == nil || deps.Pool == nil {
		return WebDomainToolSurface{}
	}
	dmarcRoutes := &dmarc.Deps{Pool: deps.Pool, Logger: deps.Logger}
	dmarcRoutes.MountRoutes(deps.Router)
	templateRoutes := &email_template.Deps{}
	templateRoutes.MountRoutes(deps.Router)
	domainRoutes := &custom_domains.Deps{
		Repo: &custom_domains.Repo{Pool: deps.Pool}, Resolver: custom_domains.DefaultResolver(),
	}
	domainRoutes.MountRoutes(deps.Router)
	linkRoutes := &link_checker.Deps{Pool: deps.Pool}
	linkRoutes.MountRoutes(deps.Router)
	return WebDomainToolSurface{
		DMARC: dmarcRoutes, EmailTemplate: templateRoutes, CustomDomains: domainRoutes, LinkChecker: linkRoutes,
	}
}
