use std::any::Any;
use std::fmt;
use std::sync::Arc;

use crate::{CollectionDefinition, CollectionError};

type CollectionTransformFn<T> = Arc<dyn Fn(&T) -> T + Send + Sync>;
type CollectionValidateFn<T> = Arc<dyn Fn(&T) -> Result<(), CollectionError> + Send + Sync>;
type CollectionMigrateFn<T> =
    Arc<dyn Fn(Box<dyn Any>, u32) -> Result<T, CollectionError> + Send + Sync>;

#[derive(Clone)]
pub struct CollectionSchema<T> {
    version: u32,
    defaults: Option<CollectionTransformFn<T>>,
    normalize: Option<CollectionTransformFn<T>>,
    validate: Option<CollectionValidateFn<T>>,
    migrate: Option<CollectionMigrateFn<T>>,
}

impl<T> CollectionSchema<T> {
    pub fn new(version: u32) -> Self {
        Self {
            version,
            defaults: None,
            normalize: None,
            validate: None,
            migrate: None,
        }
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn with_defaults(mut self, defaults: impl Fn(&T) -> T + Send + Sync + 'static) -> Self {
        self.defaults = Some(Arc::new(defaults));
        self
    }

    pub fn with_normalize(mut self, normalize: impl Fn(&T) -> T + Send + Sync + 'static) -> Self {
        self.normalize = Some(Arc::new(normalize));
        self
    }

    pub fn with_validate(
        mut self,
        validate: impl Fn(&T) -> Result<(), CollectionError> + Send + Sync + 'static,
    ) -> Self {
        self.validate = Some(Arc::new(validate));
        self
    }

    pub fn with_migrate_from<Raw: 'static>(
        mut self,
        migrate: impl Fn(Raw, u32) -> Result<T, CollectionError> + Send + Sync + 'static,
    ) -> Self {
        self.migrate = Some(Arc::new(move |value, from_version| {
            let raw = value.downcast::<Raw>().map_err(|_| {
                CollectionError::Validation(format!(
                    "collection schema migration expected value of type {}",
                    std::any::type_name::<Raw>()
                ))
            })?;
            migrate(*raw, from_version)
        }));
        self
    }

    pub(crate) fn defaults(&self) -> Option<&CollectionTransformFn<T>> {
        self.defaults.as_ref()
    }

    pub(crate) fn normalize(&self) -> Option<&CollectionTransformFn<T>> {
        self.normalize.as_ref()
    }

    pub(crate) fn validate(&self) -> Option<&CollectionValidateFn<T>> {
        self.validate.as_ref()
    }

    pub(crate) fn migrate(&self) -> Option<&CollectionMigrateFn<T>> {
        self.migrate.as_ref()
    }
}

impl<T> fmt::Debug for CollectionSchema<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CollectionSchema")
            .field("version", &self.version)
            .finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct NormalizeCollectionItemOptions {
    pub from_version: Option<u32>,
}

pub fn get_collection_schema<T>(
    definition: &CollectionDefinition<T>,
) -> Option<&CollectionSchema<T>> {
    definition.schema()
}

pub fn get_schema_version<T>(definition: &CollectionDefinition<T>) -> u32 {
    get_collection_schema(definition)
        .map(CollectionSchema::version)
        .unwrap_or(1)
}

pub fn normalize_collection_item<T: 'static, Raw: 'static>(
    definition: &CollectionDefinition<T>,
    value: Raw,
    options: NormalizeCollectionItemOptions,
) -> Result<T, CollectionError> {
    let Some(schema) = get_collection_schema(definition) else {
        return downcast_value(
            value,
            "collection item type does not match definition without schema migration",
        );
    };

    let from_version = options.from_version.unwrap_or(schema.version());
    let next = if from_version != schema.version() {
        let migrate = schema.migrate().ok_or_else(|| {
            CollectionError::Validation(format!(
                "collection schema migration required: {} -> {}",
                from_version,
                schema.version()
            ))
        })?;
        migrate(Box::new(value), from_version)?
    } else {
        downcast_value(
            value,
            "collection item type does not match definition for current schema version",
        )?
    };

    apply_schema(schema, next)
}

pub(crate) fn normalize_typed_collection_item<T: Clone>(
    definition: &CollectionDefinition<T>,
    value: &T,
) -> Result<T, CollectionError> {
    let Some(schema) = get_collection_schema(definition) else {
        return Ok(value.clone());
    };
    apply_schema(schema, value.clone())
}

fn apply_schema<T>(schema: &CollectionSchema<T>, mut value: T) -> Result<T, CollectionError> {
    if let Some(defaults) = schema.defaults() {
        value = defaults(&value);
    }
    if let Some(normalize) = schema.normalize() {
        value = normalize(&value);
    }
    if let Some(validate) = schema.validate() {
        validate(&value)?;
    }
    Ok(value)
}

fn downcast_value<T: 'static, Raw: 'static>(
    value: Raw,
    context: &str,
) -> Result<T, CollectionError> {
    let boxed: Box<dyn Any> = Box::new(value);
    boxed
        .downcast::<T>()
        .map(|value| *value)
        .map_err(|_| CollectionError::Validation(context.to_string()))
}
