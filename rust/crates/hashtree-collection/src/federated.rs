use std::cmp::max;
use std::collections::BTreeMap;

use futures::future::join_all;
use hashtree_core::{Cid, Store};

use crate::{CollectionError, CollectionSource, SearchOptions};

#[derive(Debug, Clone, Default)]
pub struct FederatedSearchOptions {
    pub limit: Option<usize>,
    pub full_match: bool,
    pub per_source_limit: Option<usize>,
}

#[derive(Clone)]
pub struct FederatedCollectionSource<'a, S: Store> {
    pub source_id: String,
    pub boost: usize,
    pub source: &'a CollectionSource<S>,
}

impl<'a, S: Store> FederatedCollectionSource<'a, S> {
    pub fn new(source_id: impl Into<String>, source: &'a CollectionSource<S>) -> Self {
        Self {
            source_id: source_id.into(),
            boost: 1,
            source,
        }
    }

    pub fn with_boost(mut self, boost: usize) -> Self {
        self.boost = boost;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FederatedSearchSourceHit {
    pub source_id: String,
    pub cid: Cid,
    pub score: usize,
    pub boost: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FederatedSearchHit {
    pub id: String,
    pub cid: Cid,
    pub score: usize,
    pub best_source_id: String,
    pub source_ids: Vec<String>,
    pub hits: Vec<FederatedSearchSourceHit>,
}

pub async fn federated_search<'a, S: Store + 'a>(
    sources: impl IntoIterator<Item = FederatedCollectionSource<'a, S>>,
    index_name: &str,
    query: &str,
    options: FederatedSearchOptions,
) -> Result<Vec<FederatedSearchHit>, CollectionError> {
    let source_list = sources.into_iter().collect::<Vec<_>>();
    let limit = options.limit.unwrap_or(20);
    if limit == 0 {
        return Ok(Vec::new());
    }

    let per_source_limit = options
        .per_source_limit
        .unwrap_or(max(limit.saturating_mul(2), 20));
    let search_options = SearchOptions {
        limit: Some(per_source_limit),
        full_match: options.full_match,
    };

    let local_results = join_all(source_list.iter().map(|source_input| {
        let source_id = source_input.source_id.clone();
        let boost = source_input.boost;
        let search_options = search_options.clone();
        async move {
            let results = source_input
                .source
                .search(index_name, query, search_options)
                .await?;
            Ok::<_, CollectionError>(
                results
                    .into_iter()
                    .map(|result| WeightedFederatedSearchHit {
                        source_id: source_id.clone(),
                        cid: result.cid,
                        id: result.id,
                        score: result.score,
                        boost,
                        weighted_score: result.score.saturating_mul(boost),
                    })
                    .collect::<Vec<_>>(),
            )
        }
    }))
    .await;

    #[derive(Debug)]
    struct AggregateHit {
        cid: Cid,
        score: usize,
        best_source_id: String,
        source_ids: Vec<String>,
        hits: Vec<FederatedSearchSourceHit>,
        best_weighted_score: usize,
    }

    let mut merged = BTreeMap::<String, AggregateHit>::new();
    for result_set in local_results {
        for result in result_set? {
            let hit = FederatedSearchSourceHit {
                source_id: result.source_id.clone(),
                cid: result.cid.clone(),
                score: result.score,
                boost: result.boost,
            };

            match merged.get_mut(&result.id) {
                None => {
                    merged.insert(
                        result.id,
                        AggregateHit {
                            cid: result.cid,
                            score: result.weighted_score,
                            best_source_id: result.source_id.clone(),
                            source_ids: vec![result.source_id],
                            hits: vec![hit],
                            best_weighted_score: result.weighted_score,
                        },
                    );
                }
                Some(existing) => {
                    existing.score = existing.score.saturating_add(result.weighted_score);
                    if !existing
                        .source_ids
                        .iter()
                        .any(|source_id| source_id == &result.source_id)
                    {
                        existing.source_ids.push(result.source_id.clone());
                    }
                    existing.hits.push(hit);

                    if result.weighted_score > existing.best_weighted_score {
                        existing.best_weighted_score = result.weighted_score;
                        existing.best_source_id = result.source_id;
                        existing.cid = result.cid;
                    }
                }
            }
        }
    }

    let mut results = merged
        .into_iter()
        .map(|(id, aggregate)| FederatedSearchHit {
            id,
            cid: aggregate.cid,
            score: aggregate.score,
            best_source_id: aggregate.best_source_id,
            source_ids: aggregate.source_ids,
            hits: aggregate.hits,
        })
        .collect::<Vec<_>>();

    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then(right.source_ids.len().cmp(&left.source_ids.len()))
            .then(left.id.cmp(&right.id))
    });
    results.truncate(limit);
    Ok(results)
}

#[derive(Debug)]
struct WeightedFederatedSearchHit {
    source_id: String,
    cid: Cid,
    id: String,
    score: usize,
    boost: usize,
    weighted_score: usize,
}
