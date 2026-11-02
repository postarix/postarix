{{- define "postarix.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "postarix.labels" -}}
app.kubernetes.io/part-of: postarix
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: include "postarix.selector" (list . "api") */}}
{{- define "postarix.selector" -}}
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* Image of one of our components: include "postarix.image" (list . "api") */}}
{{- define "postarix.image" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $tag := default $root.Chart.AppVersion $root.Values.image.tag -}}
{{- if $root.Values.image.registry -}}{{ printf "%s/%s:%s" $root.Values.image.registry $name $tag }}{{- else -}}{{ printf "postarix/%s:%s" $name $tag }}{{- end -}}
{{- end -}}

{{- define "postarix.name" -}}{{ include "postarix.fullname" (index . 0) }}-{{ index . 1 }}{{- end -}}

{{- define "postarix.secretName" -}}
{{- default (printf "%s-secrets" (include "postarix.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{- define "postarix.postgresHost" -}}
{{- if .Values.postgresql.enabled -}}{{ include "postarix.name" (list . "postgres") }}{{- else -}}{{ required "postgresql.host is required when postgresql.enabled is false" .Values.postgresql.host }}{{- end -}}
{{- end -}}

{{- define "postarix.valkeyHost" -}}
{{- if .Values.valkey.enabled -}}{{ include "postarix.name" (list . "valkey") }}{{- else -}}{{ required "valkey.host is required when valkey.enabled is false" .Values.valkey.host }}{{- end -}}
{{- end -}}

{{/* An environment variable read from the chart's secret. */}}
{{- define "postarix.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ include "postarix.secretName" (index . 0) }}
      key: {{ index . 1 }}
{{- end -}}

{{/* Pod security defaults shared by every container. */}}
{{- define "postarix.containerSecurity" -}}
allowPrivilegeEscalation: false
seccompProfile:
  type: RuntimeDefault
capabilities:
  drop: [NET_RAW]
{{- end -}}

{{/* The Node.js apps run unprivileged and need no capability at all. */}}
{{- define "postarix.appSecurity" -}}
allowPrivilegeEscalation: false
seccompProfile:
  type: RuntimeDefault
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Murder backends: "<pod>.<service>" names, space-separated (frontend) or as name=host pairs (API). */}}
{{- define "postarix.murderBackends" -}}
{{- $root := index . 0 -}}
{{- $pairs := index . 1 -}}
{{- $backend := include "postarix.name" (list $root "cyrus-backend") -}}
{{- $out := list -}}
{{- range $i := until (int $root.Values.mail.murder.backends) -}}
{{- $host := printf "%s-%d.%s" $backend $i $backend -}}
{{- if $pairs -}}{{- $out = append $out (printf "b%d=%s" $i $host) -}}{{- else -}}{{- $out = append $out $host -}}{{- end -}}
{{- end -}}
{{- if $pairs -}}{{ join "," $out }}{{- else -}}{{ join " " $out }}{{- end -}}
{{- end -}}
