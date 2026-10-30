// SPDX-License-Identifier: AGPL-3.0-only
//
// copper.go — native Copper CRM provider runtime.
//
// Copper authenticates with a static API key plus the account email via the
// X-PW-AccessToken / X-PW-Application / X-PW-UserEmail header triplet. Listing
// people is a POST /people/search with page_number/page_size paging. Static
// token, so no OAuth/refresh/worker — dispatched via providerManagedSyncRequest.
package crm_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	copperDefaultAPIBaseURL       = "https://api.copper.com/developer_api/v1"
	copperDefaultUserAgent        = "Moosewave Copper Integration"
	copperDefaultPageSize         = 100
	copperMaxPageSize             = 200
	copperCursorPrefix            = "copper:"
	copperCompanyCursorPrefix     = "copper:companies:"
	copperOpportunityCursorPrefix = "copper:opportunities:"
	copperProjectCursorPrefix     = "copper:projects:"
	copperActivityCursorPrefix    = "copper:activities:"
	copperCursorComplete          = "copper:complete"
)

const (
	copperPhasePeople        = "people"
	copperPhaseCompanies     = "companies"
	copperPhaseOpportunities = "opportunities"
	copperPhaseProjects      = "projects"
	copperPhaseActivities    = "activities"
)

var copperBackfillPhaseOrder = []string{
	copperPhasePeople,
	copperPhaseCompanies,
	copperPhaseOpportunities,
	copperPhaseProjects,
	copperPhaseActivities,
}

type CopperCredentials struct {
	APIKey     string
	Email      string
	APIBaseURL string
	UserAgent  string
}

type CopperCredentialResolver interface {
	ResolveCopper(context.Context, string, Integration) (CopperCredentials, error)
}

type copperCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	Email      string `json:"email"`
	UserEmail  string `json:"user_email"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p copperCredentialPayload) credentials() (CopperCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	email := strings.TrimSpace(firstString(p.Email, p.UserEmail))
	if key == "" || email == "" {
		return CopperCredentials{}, fmt.Errorf("copper api_key and email are required")
	}
	return CopperCredentials{APIKey: key, Email: email, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type CopperSecretsCredentialResolver struct {
	Secrets CRMStaticSecretResolver
}

func NewCopperSecretsCredentialResolver(secrets CRMStaticSecretResolver) *CopperSecretsCredentialResolver {
	return &CopperSecretsCredentialResolver{Secrets: secrets}
}

func (r *CopperSecretsCredentialResolver) ResolveCopper(ctx context.Context, _ string, integration Integration) (CopperCredentials, error) {
	if r == nil || r.Secrets == nil {
		return CopperCredentials{}, fmt.Errorf("copper credential resolver is not configured")
	}
	ref := crmStaticCredentialRef(integration)
	if ref == "" {
		return CopperCredentials{}, fmt.Errorf("copper credentials_ref is required")
	}
	var payload copperCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withCopperDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return CopperCredentials{}, fmt.Errorf("resolve copper credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withCopperDefaults(creds, integration), nil
			}
		}
	}
	return CopperCredentials{}, fmt.Errorf("copper requires a JSON {api_key, email} secret")
}

func withCopperDefaults(creds CopperCredentials, integration Integration) CopperCredentials {
	if creds.Email == "" {
		creds.Email = strings.TrimSpace(settingString(integration.Settings, "email"))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type CopperBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type CopperRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials CopperCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type copperPerson struct {
	ID     json.Number `json:"id"`
	Name   string      `json:"name"`
	Title  string      `json:"title"`
	Emails []struct {
		Email string `json:"email"`
	} `json:"emails"`
	PhoneNumbers []struct {
		Number string `json:"number"`
	} `json:"phone_numbers"`
	CompanyName string `json:"company_name"`
}

func (b CopperRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderCopper {
		return SyncRequest{}, fmt.Errorf("copper backfill requires a Copper integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("copper credential resolver is not configured")
	}
	phase, page, done := copperCursorState(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: copperCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveCopper(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderCopper)
	pageSize := crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), copperDefaultPageSize, copperMaxPageSize)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/"), strings.TrimRight(creds.APIBaseURL, "/"), copperDefaultAPIBaseURL)
	headers := copperAuthHeaders(creds)
	runtime := copperRuntime{
		ctx:         ctx,
		client:      client,
		baseURL:     baseURL,
		headers:     headers,
		userAgent:   firstString(b.UserAgent, creds.UserAgent, copperDefaultUserAgent),
		integration: integration,
	}
	switch phase {
	case copperPhasePeople:
		return runtime.backfillPeoplePage(page, pageSize)
	case copperPhaseCompanies:
		return runtime.backfillCompaniesPage(page, pageSize)
	case copperPhaseOpportunities:
		return runtime.backfillOpportunitiesPage(page, pageSize)
	case copperPhaseProjects:
		return runtime.backfillProjectsPage(page, pageSize)
	case copperPhaseActivities:
		return runtime.backfillActivitiesPage(page, pageSize)
	default:
		return SyncRequest{}, fmt.Errorf("unsupported copper cursor phase %q", phase)
	}
}

type copperRuntime struct {
	ctx         context.Context
	client      *http.Client
	baseURL     string
	headers     map[string]string
	userAgent   string
	integration Integration
}

func (rt copperRuntime) backfillPeoplePage(page, pageSize int) (SyncRequest, error) {
	var people []copperPerson
	if err := crmStaticDoJSON(rt.ctx, rt.client, http.MethodPost, rt.baseURL, "/people/search", nil, rt.headers, copperSearchBody(page, pageSize, map[string]any{"sort_by": "date_modified"}), rt.userAgent, &people); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(people))
	for _, p := range people {
		if mapped, ok := mapCopperPerson(p, rt.integration); ok {
			contacts = append(contacts, mapped)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: copperNextCursor(copperPhasePeople, page, pageSize, len(people), rt.integration)}), nil
}

func (rt copperRuntime) backfillCompaniesPage(page, pageSize int) (SyncRequest, error) {
	companies, err := rt.searchRecords("/companies/search", page, pageSize, map[string]any{"sort_by": "date_modified"})
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(companies))
	for _, company := range companies {
		contact, ok, err := rt.companyContact(company)
		if err != nil {
			return SyncRequest{}, err
		}
		if ok {
			contacts = append(contacts, contact)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: copperNextCursor(copperPhaseCompanies, page, pageSize, len(companies), rt.integration)}), nil
}

func (rt copperRuntime) backfillOpportunitiesPage(page, pageSize int) (SyncRequest, error) {
	opportunities, err := rt.searchRecords("/opportunities/search", page, pageSize, map[string]any{"sort_by": "date_modified"})
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(opportunities))
	for _, opportunity := range opportunities {
		resolved, ok, err := rt.resolveOpportunityContact(opportunity)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapCopperOpportunityEvent(opportunity, resolved, rt.integration, ""); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: copperNextCursor(copperPhaseOpportunities, page, pageSize, len(opportunities), rt.integration)}), nil
}

func (rt copperRuntime) backfillProjectsPage(page, pageSize int) (SyncRequest, error) {
	projects, err := rt.searchRecords("/projects/search", page, pageSize, map[string]any{"sort_by": "date_modified"})
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(projects))
	for _, project := range projects {
		resolved, ok, err := rt.resolveRelatedContact(project)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapCopperProjectEvent(project, resolved, rt.integration, ""); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: copperNextCursor(copperPhaseProjects, page, pageSize, len(projects), rt.integration)}), nil
}

func (rt copperRuntime) backfillActivitiesPage(page, pageSize int) (SyncRequest, error) {
	activities, err := rt.searchRecords("/activities/search", page, pageSize, nil)
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(activities))
	for _, activity := range activities {
		resolved, ok, err := rt.resolveRelatedContact(activity)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapCopperActivityEvent(activity, resolved, rt.integration, ""); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: copperNextCursor(copperPhaseActivities, page, pageSize, len(activities), rt.integration)}), nil
}

func (rt copperRuntime) searchRecords(path string, page, pageSize int, extra map[string]any) ([]map[string]any, error) {
	var records []map[string]any
	if err := crmStaticDoJSON(rt.ctx, rt.client, http.MethodPost, rt.baseURL, path, nil, rt.headers, copperSearchBody(page, pageSize, extra), rt.userAgent, &records); err != nil {
		return nil, err
	}
	return records, nil
}

func (rt copperRuntime) fetchRecord(collection, id string) (map[string]any, error) {
	var record map[string]any
	if err := crmStaticDoJSON(rt.ctx, rt.client, http.MethodGet, rt.baseURL, "/"+strings.Trim(collection, "/")+"/"+url.PathEscape(strings.TrimSpace(id)), nil, rt.headers, nil, rt.userAgent, &record); err != nil {
		return nil, err
	}
	return record, nil
}

func (rt copperRuntime) fetchPerson(id string) (copperPerson, error) {
	return fetchCopperPerson(rt.ctx, rt.client, rt.baseURL, rt.headers, rt.userAgent, id)
}

func fetchCopperPerson(ctx context.Context, client *http.Client, baseURL string, headers map[string]string, userAgent, id string) (copperPerson, error) {
	path := "/people/" + url.PathEscape(strings.TrimSpace(id))
	var person copperPerson
	if err := crmStaticDoJSON(ctx, crmHTTPClient(client, ProviderCopper), http.MethodGet, baseURL, path, nil, headers, nil, firstString(userAgent, copperDefaultUserAgent), &person); err != nil {
		return copperPerson{}, err
	}
	return person, nil
}

func copperAuthHeaders(creds CopperCredentials) map[string]string {
	return map[string]string{
		"X-PW-AccessToken": strings.TrimSpace(creds.APIKey),
		"X-PW-Application": "developer_api",
		"X-PW-UserEmail":   strings.TrimSpace(creds.Email),
	}
}

type copperResolvedContact struct {
	Person      copperPerson
	PersonID    string
	Company     map[string]any
	Opportunity map[string]any
	RelatedType string
	RelatedID   string
}

func (rt copperRuntime) companyContact(company map[string]any) (ContactInput, bool, error) {
	primaryContactID := copperRecordString(company, "primary_contact_id", "person_id", "contact_id")
	if primaryContactID == "" {
		return ContactInput{}, false, nil
	}
	person, err := rt.fetchPerson(primaryContactID)
	if err != nil {
		return ContactInput{}, false, err
	}
	contact, ok := mapCopperCompanyContact(company, person, rt.integration)
	return contact, ok, nil
}

func (rt copperRuntime) resolveOpportunityContact(opportunity map[string]any) (copperResolvedContact, bool, error) {
	personID := copperRecordString(opportunity, "primary_contact_id", "person_id", "contact_id")
	company := copperRecordMapValue(opportunity["company"])
	companyID := firstString(copperRecordString(opportunity, "company_id"), copperRecordString(company, "id"))
	if personID == "" && companyID != "" {
		fetched, err := rt.fetchRecord("companies", companyID)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		company = fetched
		personID = copperRecordString(company, "primary_contact_id", "person_id", "contact_id")
	}
	if personID == "" {
		return copperResolvedContact{}, false, nil
	}
	person, err := rt.fetchPerson(personID)
	if err != nil {
		return copperResolvedContact{}, false, err
	}
	return copperResolvedContact{
		Person:      person,
		PersonID:    firstString(copperPersonID(person), personID),
		Company:     company,
		Opportunity: opportunity,
		RelatedType: "opportunity",
		RelatedID:   copperRecordString(opportunity, "id"),
	}, true, nil
}

func (rt copperRuntime) resolveRelatedContact(record map[string]any) (copperResolvedContact, bool, error) {
	return rt.resolveRelatedContactDepth(record, 0)
}

func (rt copperRuntime) resolveRelatedContactDepth(record map[string]any, depth int) (copperResolvedContact, bool, error) {
	if depth > 4 {
		return copperResolvedContact{}, false, nil
	}
	for _, key := range []string{"parent", "related_resource"} {
		if related := copperRecordMapValue(record[key]); len(related) > 0 {
			if resolved, ok, err := rt.resolveRelatedEntity(copperRecordString(related, "type"), copperRecordString(related, "id"), depth+1); err != nil || ok {
				return resolved, ok, err
			}
		}
	}
	if entityType := firstString(copperRecordString(record, "parent_type"), copperRecordString(record, "related_resource_type")); entityType != "" {
		if resolved, ok, err := rt.resolveRelatedEntity(entityType, firstString(copperRecordString(record, "parent_id"), copperRecordString(record, "related_resource_id")), depth+1); err != nil || ok {
			return resolved, ok, err
		}
	}
	if personID := copperRecordString(record, "primary_contact_id", "person_id", "contact_id"); personID != "" {
		person, err := rt.fetchPerson(personID)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		return copperResolvedContact{Person: person, PersonID: firstString(copperPersonID(person), personID), RelatedID: personID, RelatedType: "person"}, true, nil
	}
	if opportunityID := copperRecordString(record, "opportunity_id"); opportunityID != "" {
		opportunity, err := rt.fetchRecord("opportunities", opportunityID)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		return rt.resolveOpportunityContact(opportunity)
	}
	if companyID := copperRecordString(record, "company_id"); companyID != "" {
		company, err := rt.fetchRecord("companies", companyID)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		contact, ok, err := rt.resolveCompanyContact(company)
		if ok {
			contact.Company = company
		}
		return contact, ok, err
	}
	return copperResolvedContact{}, false, nil
}

func (rt copperRuntime) resolveRelatedEntity(entityType, id string, depth int) (copperResolvedContact, bool, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return copperResolvedContact{}, false, nil
	}
	switch copperNormalizeEntityType(entityType) {
	case "person":
		person, err := rt.fetchPerson(id)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		return copperResolvedContact{Person: person, PersonID: firstString(copperPersonID(person), id), RelatedType: "person", RelatedID: id}, true, nil
	case "company":
		company, err := rt.fetchRecord("companies", id)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		resolved, ok, err := rt.resolveCompanyContact(company)
		if ok {
			resolved.Company = company
			resolved.RelatedType = "company"
			resolved.RelatedID = id
		}
		return resolved, ok, err
	case "opportunity":
		opportunity, err := rt.fetchRecord("opportunities", id)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		resolved, ok, err := rt.resolveOpportunityContact(opportunity)
		if ok {
			resolved.Opportunity = opportunity
			resolved.RelatedType = "opportunity"
			resolved.RelatedID = id
		}
		return resolved, ok, err
	case "project":
		project, err := rt.fetchRecord("projects", id)
		if err != nil {
			return copperResolvedContact{}, false, err
		}
		resolved, ok, err := rt.resolveRelatedContactDepth(project, depth+1)
		if ok {
			resolved.RelatedType = "project"
			resolved.RelatedID = id
		}
		return resolved, ok, err
	default:
		return copperResolvedContact{}, false, nil
	}
}

func (rt copperRuntime) resolveCompanyContact(company map[string]any) (copperResolvedContact, bool, error) {
	personID := copperRecordString(company, "primary_contact_id", "person_id", "contact_id")
	if personID == "" {
		return copperResolvedContact{}, false, nil
	}
	person, err := rt.fetchPerson(personID)
	if err != nil {
		return copperResolvedContact{}, false, err
	}
	return copperResolvedContact{
		Person:      person,
		PersonID:    firstString(copperPersonID(person), personID),
		Company:     company,
		RelatedType: "company",
		RelatedID:   copperRecordString(company, "id"),
	}, true, nil
}

func mapCopperPerson(p copperPerson, integration Integration) (ContactInput, bool) {
	email := copperPersonEmail(p)
	if email == "" {
		return ContactInput{}, false
	}
	id := firstString(copperPersonID(p), email)
	return ContactInput{
		SourceID:       "copper://person/" + id,
		Email:          email,
		FullName:       strings.TrimSpace(p.Name),
		Phone:          copperPersonPhone(p),
		Company:        strings.TrimSpace(p.CompanyName),
		LifecycleStage: strings.TrimSpace(p.Title),
		ListIDs:        crmListIDs(integration),
		Tags:           crmDefaultTags(integration, "copper"),
		Properties:     map[string]any{"copper_id": id, "copper_raw": p},
	}, true
}

func mapCopperCompanyContact(company map[string]any, person copperPerson, integration Integration) (ContactInput, bool) {
	contact, ok := mapCopperPerson(person, integration)
	if !ok {
		return ContactInput{}, false
	}
	companyID := copperRecordString(company, "id", "company_id")
	personID := firstString(copperPersonID(person), copperRecordString(company, "primary_contact_id"), contact.Email)
	if companyID != "" {
		contact.SourceID = "copper://company/" + companyID + "/person/" + personID
	}
	contact.Company = firstString(copperRecordString(company, "name"), contact.Company)
	contact.Properties = copperEnsureProperties(contact.Properties)
	contact.Properties["copper_object"] = "company"
	contact.Properties["copper_company_id"] = companyID
	contact.Properties["copper_company_name"] = copperRecordString(company, "name")
	contact.Properties["copper_primary_contact_id"] = copperRecordString(company, "primary_contact_id")
	contact.Properties["copper_company_raw"] = company
	if updated := copperRecordTime(company, "date_modified", "updated_at", "date_created", "created_at"); updated != nil {
		contact.UpdatedAt = updated
	}
	return contact, true
}

func mapCopperOpportunityEvent(opportunity map[string]any, resolved copperResolvedContact, integration Integration, action string) (EventInput, bool) {
	email := copperPersonEmail(resolved.Person)
	opportunityID := copperRecordString(opportunity, "id", "opportunity_id")
	if email == "" || opportunityID == "" {
		return EventInput{}, false
	}
	props := copperObjectProperties("opportunity", opportunity, integration)
	props["copper_opportunity_id"] = opportunityID
	props["copper_person_id"] = resolvedPersonID(resolved)
	props["copper_status"] = copperRecordString(opportunity, "status")
	props["copper_name"] = copperRecordString(opportunity, "name")
	props["copper_company_id"] = copperRecordString(opportunity, "company_id")
	props["copper_company_name"] = firstString(copperRecordString(opportunity, "company_name"), copperRecordString(resolved.Company, "name"))
	props["copper_monetary_value"] = copperRecordString(opportunity, "monetary_value")
	props["copper_pipeline_id"] = copperRecordString(opportunity, "pipeline_id")
	props["copper_pipeline_stage_id"] = copperRecordString(opportunity, "pipeline_stage_id", "pipeline_stage")
	copperAddResolvedContext(props, resolved)
	if action = strings.TrimSpace(action); action != "" {
		props["copper_action"] = action
	}
	return EventInput{
		SourceID:   "copper://opportunity/" + opportunityID + "/person/" + resolvedPersonID(resolved),
		Email:      email,
		Phone:      copperPersonPhone(resolved.Person),
		EventName:  copperOpportunityEventName(action, copperRecordString(opportunity, "status")),
		Properties: props,
		OccurredAt: copperRecordTime(opportunity, "date_modified", "updated_at", "date_created", "created_at", "close_date"),
	}, true
}

func mapCopperProjectEvent(project map[string]any, resolved copperResolvedContact, integration Integration, action string) (EventInput, bool) {
	email := copperPersonEmail(resolved.Person)
	projectID := copperRecordString(project, "id", "project_id")
	if email == "" || projectID == "" {
		return EventInput{}, false
	}
	props := copperObjectProperties("project", project, integration)
	props["copper_project_id"] = projectID
	props["copper_person_id"] = resolvedPersonID(resolved)
	props["copper_name"] = copperRecordString(project, "name")
	props["copper_status"] = copperRecordString(project, "status")
	props["copper_related_type"] = firstString(resolved.RelatedType, copperRecordNestedString(project, "related_resource", "type"))
	props["copper_related_id"] = firstString(resolved.RelatedID, copperRecordNestedString(project, "related_resource", "id"))
	copperAddResolvedContext(props, resolved)
	if action = strings.TrimSpace(action); action != "" {
		props["copper_action"] = action
	}
	return EventInput{
		SourceID:   "copper://project/" + projectID + "/person/" + resolvedPersonID(resolved),
		Email:      email,
		Phone:      copperPersonPhone(resolved.Person),
		EventName:  copperProjectEventName(action),
		Properties: props,
		OccurredAt: copperRecordTime(project, "date_modified", "updated_at", "date_created", "created_at"),
	}, true
}

func mapCopperActivityEvent(activity map[string]any, resolved copperResolvedContact, integration Integration, action string) (EventInput, bool) {
	email := copperPersonEmail(resolved.Person)
	activityID := copperRecordString(activity, "id", "activity_id")
	if email == "" || activityID == "" {
		return EventInput{}, false
	}
	props := copperObjectProperties("activity", activity, integration)
	props["copper_activity_id"] = activityID
	props["copper_person_id"] = resolvedPersonID(resolved)
	props["copper_activity_type"] = copperRecordString(copperRecordMapValue(activity["type"]), "name", "id")
	props["copper_parent_type"] = firstString(resolved.RelatedType, copperRecordNestedString(activity, "parent", "type"))
	props["copper_parent_id"] = firstString(resolved.RelatedID, copperRecordNestedString(activity, "parent", "id"))
	copperAddResolvedContext(props, resolved)
	if action = strings.TrimSpace(action); action != "" {
		props["copper_action"] = action
	}
	return EventInput{
		SourceID:   "copper://activity/" + activityID + "/person/" + resolvedPersonID(resolved),
		Email:      email,
		Phone:      copperPersonPhone(resolved.Person),
		EventName:  copperActivityEventName(action),
		Properties: props,
		OccurredAt: copperRecordTime(activity, "activity_date", "date_modified", "updated_at", "date_created", "created_at"),
	}, true
}

func copperCursorState(cursor string) (string, int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == copperCursorComplete {
		return "", 0, true
	}
	for _, entry := range []struct {
		phase  string
		prefix string
	}{
		{copperPhaseCompanies, copperCompanyCursorPrefix},
		{copperPhaseOpportunities, copperOpportunityCursorPrefix},
		{copperPhaseProjects, copperProjectCursorPrefix},
		{copperPhaseActivities, copperActivityCursorPrefix},
	} {
		if strings.HasPrefix(cursor, entry.prefix) {
			page, done := crmPageCursor(cursor, entry.prefix, copperCursorComplete)
			return entry.phase, page, done
		}
	}
	page, done := crmPageCursor(cursor, copperCursorPrefix, copperCursorComplete)
	return copperPhasePeople, page, done
}

func copperNextCursor(phase string, page, pageSize, count int, integration Integration) string {
	if count >= pageSize {
		return copperCursorForPhase(phase, page+1)
	}
	seen := false
	for _, next := range copperBackfillPhaseOrder {
		if next == phase {
			seen = true
			continue
		}
		if !seen || !copperPhaseEnabled(integration, next) {
			continue
		}
		return copperCursorForPhase(next, 1)
	}
	return copperCursorComplete
}

func copperCursorForPhase(phase string, page int) string {
	if page <= 0 {
		page = 1
	}
	switch phase {
	case copperPhasePeople:
		return copperCursorPrefix + strconv.Itoa(page)
	case copperPhaseCompanies:
		return copperCompanyCursorPrefix + strconv.Itoa(page)
	case copperPhaseOpportunities:
		return copperOpportunityCursorPrefix + strconv.Itoa(page)
	case copperPhaseProjects:
		return copperProjectCursorPrefix + strconv.Itoa(page)
	case copperPhaseActivities:
		return copperActivityCursorPrefix + strconv.Itoa(page)
	default:
		return copperCursorComplete
	}
}

func copperPhaseEnabled(integration Integration, phase string) bool {
	switch phase {
	case copperPhasePeople:
		return true
	case copperPhaseCompanies:
		return copperSettingDefaultTrue(integration.Settings, "sync_companies")
	case copperPhaseOpportunities:
		return copperSettingDefaultTrue(integration.Settings, "sync_opportunities")
	case copperPhaseProjects:
		return copperSettingDefaultTrue(integration.Settings, "sync_projects")
	case copperPhaseActivities:
		return copperSettingDefaultTrue(integration.Settings, "sync_activities")
	default:
		return false
	}
}

func copperSettingDefaultTrue(settings map[string]any, key string) bool {
	value, ok := settings[key]
	if !ok || value == nil {
		return true
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "false", "0", "no", "off", "disabled":
			return false
		default:
			return true
		}
	case json.Number:
		n, _ := v.Int64()
		return n != 0
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	default:
		return true
	}
}

func copperSearchBody(page, pageSize int, extra map[string]any) map[string]any {
	body := map[string]any{"page_number": page, "page_size": pageSize}
	for k, v := range extra {
		if strings.TrimSpace(k) != "" && v != nil {
			body[k] = v
		}
	}
	return body
}

func copperPersonID(p copperPerson) string {
	return strings.TrimSpace(p.ID.String())
}

func copperPersonEmail(p copperPerson) string {
	for _, e := range p.Emails {
		if v := strings.ToLower(strings.TrimSpace(e.Email)); v != "" {
			return v
		}
	}
	return ""
}

func copperPersonPhone(p copperPerson) string {
	for _, ph := range p.PhoneNumbers {
		if v := strings.TrimSpace(ph.Number); v != "" {
			return v
		}
	}
	return ""
}

func resolvedPersonID(resolved copperResolvedContact) string {
	return firstString(strings.TrimSpace(resolved.PersonID), copperPersonID(resolved.Person), copperPersonEmail(resolved.Person))
}

func copperEnsureProperties(props map[string]any) map[string]any {
	if props == nil {
		return map[string]any{}
	}
	return props
}

func copperObjectProperties(object string, record map[string]any, integration Integration) map[string]any {
	props := map[string]any{
		"copper_object": object,
		"copper_raw":    record,
	}
	if configured := crmListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return props
}

func copperAddResolvedContext(props map[string]any, resolved copperResolvedContact) {
	if props == nil {
		return
	}
	if companyID := copperRecordString(resolved.Company, "id", "company_id"); companyID != "" {
		props["copper_resolved_company_id"] = companyID
		props["copper_resolved_company_name"] = copperRecordString(resolved.Company, "name")
		props["copper_resolved_company"] = copperRecordSummary(resolved.Company)
	}
	if opportunityID := copperRecordString(resolved.Opportunity, "id", "opportunity_id"); opportunityID != "" {
		props["copper_resolved_opportunity_id"] = opportunityID
		props["copper_resolved_opportunity_name"] = copperRecordString(resolved.Opportunity, "name")
		props["copper_resolved_opportunity"] = copperRecordSummary(resolved.Opportunity)
	}
}

func copperRecordSummary(record map[string]any) map[string]any {
	if len(record) == 0 {
		return nil
	}
	out := map[string]any{}
	for _, key := range []string{"id", "name", "status", "company_id", "company_name", "primary_contact_id"} {
		if value, ok := record[key]; ok && value != nil {
			out[key] = value
		}
	}
	return out
}

func copperOpportunityEventName(action, status string) string {
	action = strings.ToLower(strings.TrimSpace(action))
	switch action {
	case "new", "create", "created", "add", "added":
		return "crm.deal.created"
	case "delete", "deleted":
		return "crm.deal.deleted"
	}
	status = strings.ToLower(strings.TrimSpace(status))
	switch {
	case strings.Contains(status, "won"):
		return "crm.deal.won"
	case strings.Contains(status, "lost"), strings.Contains(status, "abandon"):
		return "crm.deal.lost"
	default:
		return "crm.deal.updated"
	}
}

func copperProjectEventName(action string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "new", "create", "created", "add", "added":
		return "crm.project.created"
	case "delete", "deleted":
		return "crm.project.deleted"
	default:
		return "crm.project.updated"
	}
}

func copperActivityEventName(action string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "new", "create", "created", "add", "added":
		return "crm.activity.created"
	case "delete", "deleted":
		return "crm.activity.deleted"
	case "update", "updated":
		return "crm.activity.updated"
	default:
		return "crm.activity.completed"
	}
}

func copperNormalizeEntityType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimSuffix(value, "s")
	switch value {
	case "people":
		return "person"
	case "company", "companie":
		return "company"
	case "opportunitie":
		return "opportunity"
	default:
		return value
	}
}

func copperRecordString(record map[string]any, keys ...string) string {
	if len(record) == 0 {
		return ""
	}
	for _, key := range keys {
		if value, ok := record[key]; ok {
			if out := copperValueString(value); out != "" {
				return out
			}
		}
	}
	return ""
}

func copperRecordNestedString(record map[string]any, key, nestedKey string) string {
	return copperRecordString(copperRecordMapValue(record[key]), nestedKey)
}

func copperValueString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case json.Number:
		return strings.TrimSpace(v.String())
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(v, 'f', 6, 64), "0"), ".")
	case float32:
		f := float64(v)
		if f == float64(int64(f)) {
			return strconv.FormatInt(int64(f), 10)
		}
		return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(f, 'f', 6, 64), "0"), ".")
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case map[string]any:
		return firstString(copperRecordString(v, "id"), copperRecordString(v, "name"), copperRecordString(v, "email"))
	case map[string]string:
		return firstString(strings.TrimSpace(v["id"]), strings.TrimSpace(v["name"]), strings.TrimSpace(v["email"]))
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func copperRecordMapValue(value any) map[string]any {
	switch v := value.(type) {
	case map[string]any:
		return v
	case map[string]string:
		out := make(map[string]any, len(v))
		for key, value := range v {
			out[key] = value
		}
		return out
	default:
		return nil
	}
}

func copperRecordTime(record map[string]any, keys ...string) *time.Time {
	if len(record) == 0 {
		return nil
	}
	for _, key := range keys {
		value, ok := record[key]
		if !ok || value == nil {
			continue
		}
		if parsed, ok := copperParseTime(value); ok {
			return &parsed
		}
	}
	return nil
}

func copperParseTime(value any) (time.Time, bool) {
	switch v := value.(type) {
	case json.Number:
		if n, err := v.Int64(); err == nil && n > 0 {
			return time.Unix(n, 0).UTC(), true
		}
	case float64:
		if v > 0 {
			return time.Unix(int64(v), 0).UTC(), true
		}
	case int:
		if v > 0 {
			return time.Unix(int64(v), 0).UTC(), true
		}
	case int64:
		if v > 0 {
			return time.Unix(v, 0).UTC(), true
		}
	case string:
		raw := strings.TrimSpace(v)
		if raw == "" {
			return time.Time{}, false
		}
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			return time.Unix(n, 0).UTC(), true
		}
		if parsed := firstParsedHubSpotTime(raw); parsed != nil {
			return *parsed, true
		}
	}
	return time.Time{}, false
}
