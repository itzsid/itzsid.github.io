---
layout: page
---
<ul>
{% for post in site.posts %}

{{ post.date | date: "%-d %B %Y }}
<br>
<h2><a href="{{ post.url }}">{{ post.title }}</a></h2>
<br>
<br>
{{ post.content}}
<br>
{% endfor %}
</ul>


